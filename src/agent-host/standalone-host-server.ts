import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import type { RpcServer } from "../contract/rpc.ts";
import { ElectronMainUnavailableError } from "./host-control.ts";
import {
  JsonLinePeer,
  STANDALONE_HOST_PROTOCOL_VERSION,
  WireMessagePort,
  type HostWireMessage,
} from "../shared/standalone-host-wire.ts";
import {
  DEFAULT_RUNTIME_LEASE_MS,
  LEGACY_HOST_DISCOVERY_FILE,
  LEGACY_HOST_LOCK_FILE,
  RUNTIME_LOCK_FILE,
  createRuntimeOwner,
  nextRuntimeGeneration,
  readRuntimeRegistry,
  removeRuntimeRegistry,
  renewRuntimeRegistry,
  runtimeOwnerMatches,
  writeRuntimeRegistry,
  type RuntimeOwnerIdentity,
  type SessionRuntimeState,
} from "../shared/runtime-registry.ts";

export interface StandaloneHostServerOptions {
  userDataDirectory: string;
  hostVersion: string;
  rpcServer: RpcServer;
  isBusy: () => boolean;
  idleExitDelayMs?: number;
  startupGraceMs?: number;
  leaseDurationMs?: number;
  leaseRenewIntervalMs?: number;
  piVersion?: string;
  getSessionStates?: () => Record<string, SessionRuntimeState>;
  onControl?: (data: unknown) => void;
  onMainDisconnected?: () => void;
  onExitRequested?: () => void | Promise<void>;
}

export interface StandaloneHostServer {
  readonly port: number;
  readonly token: string;
  readonly generation: number;
  readonly ownerToken: string;
  broadcastControl(data: unknown): void;
  sendControlWhenConnected(data: unknown, timeoutMs?: number): Promise<void>;
  requestExitWhenIdle(): void;
  notifyBusyChanged(): void;
  close(): Promise<void>;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockPid(lockPath: string): number {
  try {
    const raw = readFileSync(lockPath, "utf8");
    try {
      const value = JSON.parse(raw) as { pid?: unknown };
      return Number(value.pid ?? 0);
    } catch {
      return Number(raw);
    }
  } catch {
    return 0;
  }
}

function acquireHostLock(lockPath: string, owner: RuntimeOwnerIdentity): number {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
        return descriptor;
      } catch (error) {
        closeSync(descriptor);
        rmSync(lockPath, { force: true });
        throw error;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const ownerPid = readLockPid(lockPath);
      if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && isProcessAlive(ownerPid)) {
        throw new Error(`RUNTIME_OWNER_AMBIGUOUS: Agent Host lock belongs to live pid ${ownerPid}`);
      }
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error("Could not acquire Agent Host lock");
}

function removeLockIfOwned(lockPath: string, owner: RuntimeOwnerIdentity): void {
  try {
    const value = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<RuntimeOwnerIdentity>;
    if (!runtimeOwnerMatches(value as RuntimeOwnerIdentity, owner)) return;
    rmSync(lockPath, { force: true });
  } catch {
    /* another owner replaced or removed the lock */
  }
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Agent Host did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

export async function startStandaloneHostServer(options: StandaloneHostServerOptions): Promise<StandaloneHostServer> {
  mkdirSync(options.userDataDirectory, { recursive: true, mode: 0o700 });
  const legacyDiscoveryPath = path.join(options.userDataDirectory, LEGACY_HOST_DISCOVERY_FILE);
  const legacyLockPath = path.join(options.userDataDirectory, LEGACY_HOST_LOCK_FILE);
  const legacyOwnerPid = readLockPid(legacyLockPath);
  if (legacyOwnerPid > 0 && isProcessAlive(legacyOwnerPid)) {
    throw new Error(`RUNTIME_OWNER_AMBIGUOUS: Legacy Agent Host lock belongs to live pid ${legacyOwnerPid}`);
  }
  rmSync(legacyLockPath, { force: true });
  rmSync(legacyDiscoveryPath, { force: true });
  const existingRegistry = readRuntimeRegistry(options.userDataDirectory);
  if (existingRegistry && isProcessAlive(existingRegistry.owner.pid)) {
    throw new Error(
      `RUNTIME_OWNER_AMBIGUOUS: Runtime registry belongs to live pid ${existingRegistry.owner.pid}`,
    );
  }
  const owner = createRuntimeOwner({
    generation: nextRuntimeGeneration(options.userDataDirectory),
  });
  const lockPath = path.join(options.userDataDirectory, RUNTIME_LOCK_FILE);
  const lockDescriptor = acquireHostLock(lockPath, owner);
  const token = randomBytes(32).toString("hex");
  const peers = new Set<JsonLinePeer>();
  const clients = new Set<JsonLinePeer>();
  const connectionWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const clientPorts = new Map<JsonLinePeer, Map<string, WireMessagePort>>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let exitRequested = false;
  let exitWhenIdle = false;
  let activeClient: JsonLinePeer | undefined;

  const sessionStates = () => options.getSessionStates?.() ?? {};

  const closeClientPorts = (peer: JsonLinePeer) => {
    const ports = clientPorts.get(peer);
    if (!ports) return;
    for (const port of ports.values()) {
      options.rpcServer.detachPort(port);
      port.remoteClose();
    }
    clientPorts.delete(peer);
  };

  const requestExit = async () => {
    if (exitRequested || closed) return;
    exitRequested = true;
    await closeServer();
    await options.onExitRequested?.();
  };

  const scheduleIdleExit = () => {
    if (closed) return;
    if (idleTimer) clearTimeout(idleTimer);
    if ((!exitWhenIdle && clients.size > 0) || options.isBusy()) return;
    // Electron reconnect (rebuild / window blip) is slower than 250ms. Keep the
    // startup grace unless a version replacement explicitly asked to exit idle.
    const delay = exitWhenIdle ? (options.idleExitDelayMs ?? 250) : (options.startupGraceMs ?? 30_000);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if ((exitWhenIdle || clients.size === 0) && !options.isBusy()) void requestExit();
    }, delay);
    idleTimer.unref();
  };

  const tcpServer = net.createServer((socket: Socket) => {
    const peer = new JsonLinePeer(socket);
    peers.add(peer);
    let authenticated = false;
    const ports = new Map<string, WireMessagePort>();
    clientPorts.set(peer, ports);

    peer.onMessage((message) => {
      if (!authenticated) {
        if (message.type !== "hello" || message.token !== token) {
          peer.send({ type: "rejected", code: "AUTH_FAILED", message: "Agent Host authentication failed" });
          peer.close();
          return;
        }
        if (message.protocolVersion !== STANDALONE_HOST_PROTOCOL_VERSION) {
          peer.send({
            type: "rejected",
            code: "PROTOCOL_MISMATCH",
            message: `Agent Host protocol ${STANDALONE_HOST_PROTOCOL_VERSION} does not match client protocol ${message.protocolVersion}`,
            hostProtocolVersion: STANDALONE_HOST_PROTOCOL_VERSION,
          });
          peer.close();
          return;
        }
        if (
          (message.expectedGeneration !== undefined && message.expectedGeneration !== owner.generation) ||
          (message.expectedOwnerToken !== undefined && message.expectedOwnerToken !== owner.ownerToken)
        ) {
          peer.send({
            type: "rejected",
            code: "IDENTITY_MISMATCH",
            message: "Agent Host identity does not match runtime registry",
          });
          peer.close();
          return;
        }
        authenticated = true;
        clients.add(peer);
        activeClient = peer;
        if (idleTimer) clearTimeout(idleTimer);
        peer.send({
          type: "ready",
          pid: process.pid,
          protocolVersion: STANDALONE_HOST_PROTOCOL_VERSION,
          hostVersion: options.hostVersion,
          piVersion: options.piVersion,
          generation: owner.generation,
          ownerToken: owner.ownerToken,
          processStartedAt: owner.processStartedAt,
        });
        for (const waiter of connectionWaiters) {
          clearTimeout(waiter.timer);
          waiter.resolve();
        }
        connectionWaiters.clear();
        return;
      }
      if (message.type === "channel") {
        let port = ports.get(message.channelId);
        if (!port) {
          port = new WireMessagePort(
            message.channelId,
            (wireMessage: HostWireMessage) => peer.send(wireMessage),
            () => {
              ports.delete(message.channelId);
            },
          );
          ports.set(message.channelId, port);
          options.rpcServer.attachPort(port);
        }
        port.receive(message.data);
        return;
      }
      if (message.type === "channel-close") {
        const port = ports.get(message.channelId);
        if (!port) return;
        options.rpcServer.detachPort(port);
        port.remoteClose();
        return;
      }
      if (message.type === "control") options.onControl?.(message.data);
    });
    peer.onClose(() => {
      const wasActiveClient = activeClient === peer;
      peers.delete(peer);
      clients.delete(peer);
      if (activeClient === peer) activeClient = [...clients].at(-1);
      if (wasActiveClient && !closed) options.onMainDisconnected?.();
      closeClientPorts(peer);
      scheduleIdleExit();
    });
  });

  const port = await listen(tcpServer);
  try {
    writeRuntimeRegistry(options.userDataDirectory, {
      owner,
      endpoint: { port, token },
      protocolVersion: STANDALONE_HOST_PROTOCOL_VERSION,
      hostVersion: options.hostVersion,
      sessions: sessionStates(),
    }, options.leaseDurationMs ?? DEFAULT_RUNTIME_LEASE_MS);
  } catch (error) {
    await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
    closeSync(lockDescriptor);
    removeLockIfOwned(lockPath, owner);
    throw error;
  }
  const renewLease = () => {
    const renewed = renewRuntimeRegistry(
      options.userDataDirectory,
      owner,
      sessionStates(),
      options.leaseDurationMs ?? DEFAULT_RUNTIME_LEASE_MS,
    );
    if (!renewed && !closed) void requestExit();
  };
  const leaseTimer = setInterval(
    renewLease,
    options.leaseRenewIntervalMs ?? Math.max(1_000, Math.trunc((options.leaseDurationMs ?? DEFAULT_RUNTIME_LEASE_MS) / 3)),
  );
  leaseTimer.unref();
  scheduleIdleExit();

  async function closeServer(): Promise<void> {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    clearInterval(leaseTimer);
    for (const waiter of connectionWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Agent Host closed before Electron reconnected"));
    }
    connectionWaiters.clear();
    for (const peer of peers) {
      closeClientPorts(peer);
      peer.close();
    }
    peers.clear();
    clients.clear();
    await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
    removeRuntimeRegistry(options.userDataDirectory, owner);
    closeSync(lockDescriptor);
    removeLockIfOwned(lockPath, owner);
  }

  return {
    port,
    token,
    generation: owner.generation,
    ownerToken: owner.ownerToken,
    broadcastControl(data) {
      for (const peer of clients) peer.send({ type: "control", data });
    },
    async sendControlWhenConnected(data, timeoutMs = 30_000) {
      if (!activeClient) {
        await new Promise<void>((resolve, reject) => {
          const waiter = {
            resolve,
            reject,
            timer: setTimeout(() => {
              connectionWaiters.delete(waiter);
              reject(new ElectronMainUnavailableError(timeoutMs));
            }, timeoutMs),
          };
          connectionWaiters.add(waiter);
        });
      }
      if (!activeClient) throw new ElectronMainUnavailableError(timeoutMs);
      activeClient.send({ type: "control", data });
    },
    requestExitWhenIdle() {
      exitWhenIdle = true;
      scheduleIdleExit();
    },
    notifyBusyChanged() {
      renewLease();
      scheduleIdleExit();
    },
    close: closeServer,
  };
}
