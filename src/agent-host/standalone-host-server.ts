import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import type { RpcServer } from "../contract/rpc.ts";
import { ElectronMainUnavailableError } from "./host-control.ts";
import {
  HOST_DISCOVERY_FILE,
  HOST_LOCK_FILE,
  JsonLinePeer,
  STANDALONE_HOST_PROTOCOL_VERSION,
  WireMessagePort,
  type HostDiscoveryRecord,
  type HostWireMessage,
} from "../shared/standalone-host-wire.ts";

export interface StandaloneHostServerOptions {
  userDataDirectory: string;
  hostVersion: string;
  rpcServer: RpcServer;
  isBusy: () => boolean;
  idleExitDelayMs?: number;
  startupGraceMs?: number;
  piVersion?: string;
  onControl?: (data: unknown) => void;
  onMainDisconnected?: () => void;
  onExitRequested?: () => void | Promise<void>;
}

export interface StandaloneHostServer {
  readonly port: number;
  readonly token: string;
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

function acquireHostLock(lockPath: string): number {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(descriptor, String(process.pid), "utf8");
      return descriptor;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      let ownerPid = 0;
      try {
        ownerPid = Number(readFileSync(lockPath, "utf8"));
      } catch {
        ownerPid = 0;
      }
      if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && isProcessAlive(ownerPid)) {
        throw new Error(`Agent Host is already running with pid ${ownerPid}`);
      }
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error("Could not acquire Agent Host lock");
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
  const discoveryPath = path.join(options.userDataDirectory, HOST_DISCOVERY_FILE);
  const lockPath = path.join(options.userDataDirectory, HOST_LOCK_FILE);
  const lockDescriptor = acquireHostLock(lockPath);
  const token = randomBytes(32).toString("hex");
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
      clients.delete(peer);
      if (activeClient === peer) activeClient = [...clients].at(-1);
      if (wasActiveClient) options.onMainDisconnected?.();
      closeClientPorts(peer);
      scheduleIdleExit();
    });
  });

  const port = await listen(tcpServer);
  const discovery: HostDiscoveryRecord = {
    pid: process.pid,
    port,
    token,
    protocolVersion: STANDALONE_HOST_PROTOCOL_VERSION,
    hostVersion: options.hostVersion,
    startedAt: new Date().toISOString(),
  };
  const temporaryDiscoveryPath = `${discoveryPath}.${process.pid}.tmp`;
  writeFileSync(temporaryDiscoveryPath, `${JSON.stringify(discovery)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryDiscoveryPath, discoveryPath);
  scheduleIdleExit();

  async function closeServer(): Promise<void> {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    for (const waiter of connectionWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Agent Host closed before Electron reconnected"));
    }
    connectionWaiters.clear();
    for (const peer of clients) {
      closeClientPorts(peer);
      peer.close();
    }
    clients.clear();
    await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
    rmSync(discoveryPath, { force: true });
    closeSync(lockDescriptor);
    rmSync(lockPath, { force: true });
  }

  return {
    port,
    token,
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
    notifyBusyChanged: scheduleIdleExit,
    close: closeServer,
  };
}
