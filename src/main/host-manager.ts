/**
 * Connects Electron Main to the standalone Agent Host.
 * Renderer MessagePorts remain inside Electron and are bridged over the
 * reconnectable loopback transport.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app, MessageChannelMain, type MessagePortMain } from "electron";
import type { BrowserCapabilitySnapshot } from "../contract/browser";
import { interruptCommandDescendants, terminatePidTree } from "../agent-host/process-tree";
import type { ToolchainSnapshot } from "../shared/toolchains/types";
import { HOST_DISCOVERY_FILE, type WireMessagePort } from "../shared/standalone-host-wire";
import { BrowserError } from "./browser/browser-error";
import { appendMainLog } from "./logger";
import { connectStandaloneHost, readHostDiscovery, type StandaloneHostConnection } from "./standalone-host-client";

const PING_INTERVAL_MS = 15_000;
const PING_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 500;
const START_TIMEOUT_MS = 15_000;

export type HostStatus = "starting" | "ready" | "crashed" | "stopped";

export type HostMessage =
  | { type: "ready"; ts?: number; piVersion?: string }
  | { type: "pong"; ts?: number }
  | { type: "log"; message: string }
  | { type: "running-sessions"; sessionIds: string[] }
  | { type: "agent-end"; sessionId: string; eventType?: string }
  | { type: "toolchain:ack"; revision: number }
  | { type: "browser:ack"; revision: number }
  | { type: string; [key: string]: unknown };

interface RendererBridge {
  localPort: MessagePortMain;
  remotePort: WireMessagePort;
  close(): void;
}

interface HostManagerOptions {
  userDataDirectory?: string;
  hostVersion?: string;
  executable?: string;
  environment?: NodeJS.ProcessEnv;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class HostManager {
  private connection: StandaloneHostConnection | null = null;
  private status: HostStatus = "stopped";
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPong = 0;
  private onStatusChange: ((status: HostStatus, detail?: string) => void) | null = null;
  private onHostMessage: ((message: HostMessage) => void) | null = null;
  private requestHandler: ((method: string, params: unknown) => Promise<unknown>) | null = null;
  private toolchainSnapshot: ToolchainSnapshot | null = null;
  private toolchainAckRevision = -1;
  private browserCapabilitySnapshot: BrowserCapabilitySnapshot | null = null;
  private browserAckRevision = -1;
  private piVersion: string | null = null;
  private bashChildPids = new Set<number>();
  private runningSessionIds = new Set<string>();
  private rendererBridges = new Set<RendererBridge>();
  private reconnectReason: "connection-recovery" | "crash-recovery" | null = null;
  private stopped = true;
  private launchAttempted = false;
  private readonly userDataDirectory: string;
  private readonly hostVersion: string;
  private readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly externallySupervised: boolean;

  constructor(
    private readonly hostEntry: string,
    options: HostManagerOptions = {},
  ) {
    this.userDataDirectory = options.userDataDirectory ?? app.getPath("userData");
    const developmentBuildIdentity = fs.existsSync(hostEntry)
      ? String(Math.trunc(fs.statSync(hostEntry).mtimeMs))
      : "missing";
    this.hostVersion = options.hostVersion ?? (app.isPackaged ? app.getVersion() : developmentBuildIdentity);
    this.executable = options.executable ?? process.execPath;
    this.environment = options.environment ?? process.env;
    this.externallySupervised = this.environment.PI_DESKTOP_HOST_EXTERNAL_SUPERVISOR === "1";
  }

  setStatusListener(callback: (status: HostStatus, detail?: string) => void): void {
    this.onStatusChange = callback;
  }

  setMessageListener(callback: (message: HostMessage) => void): void {
    this.onHostMessage = callback;
  }

  setRequestHandler(callback: (method: string, params: unknown) => Promise<unknown>): void {
    this.requestHandler = callback;
  }

  getStatus(): HostStatus {
    return this.status;
  }

  getPiVersion(): string | null {
    return this.piVersion;
  }

  setToolchainSnapshot(snapshot: ToolchainSnapshot): void {
    this.toolchainSnapshot = structuredClone(snapshot);
    if (this.connection && this.status === "ready") this.postToolchainSnapshot("toolchain:changed");
  }

  getToolchainAckRevision(): number {
    return this.toolchainAckRevision;
  }

  setBrowserCapabilitySnapshot(snapshot: BrowserCapabilitySnapshot): void {
    this.browserCapabilitySnapshot = structuredClone(snapshot);
    if (this.connection && this.status === "ready") this.postBrowserSnapshot("browser:changed");
  }

  getBrowserAckRevision(): number {
    return this.browserAckRevision;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.launchAttempted = false;
    this.setStatus("starting");
    void this.connectOrLaunch();
  }

  async stop(options: { exitWhenIdle?: boolean; timeoutMs?: number } = {}): Promise<void> {
    this.stopped = true;
    this.clearPing();
    this.clearReconnect();
    const connection = this.connection;
    let exitError: unknown;
    if (options.exitWhenIdle && connection) {
      const timeoutMs = options.timeoutMs ?? 10_000;
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`Agent Host did not exit while idle within ${timeoutMs}ms`));
          }, timeoutMs);
          const unsubscribe = connection.onClose(() => {
            clearTimeout(timer);
            unsubscribe();
            resolve();
          });
          connection.sendControl({ type: "replace-when-idle", expectedHostVersion: this.hostVersion });
        });
      } catch (error) {
        exitError = error;
      }
    }
    for (const bridge of this.rendererBridges) bridge.close();
    this.rendererBridges.clear();
    connection?.close();
    this.connection = null;
    this.bashChildPids.clear();
    this.runningSessionIds.clear();
    this.reconnectReason = null;
    this.setStatus("stopped");
    if (exitError) throw exitError;
  }

  abortSession(sessionId: string): void {
    const bashPids = [...this.bashChildPids];
    for (const pid of bashPids) terminatePidTree(pid);
    const hostPid = this.connection?.pid;
    if (typeof hostPid === "number") {
      interruptCommandDescendants(hostPid, (pids) => {
        appendMainLog(`session-abort killed host-children=${pids.join(",") || "none"}`);
      });
    }
    if (!this.connection) {
      appendMainLog(`session-abort dropped (no host): ${sessionId}`);
      return;
    }
    this.connection.sendControl({ type: "session-abort", sessionId });
    appendMainLog(
      `session-abort ${sessionId} interrupt host=${hostPid ?? "none"} bash=${bashPids.join(",") || "none"}`,
    );
  }

  setCockpitRunning(sessionId: string, running: boolean): void {
    this.connection?.sendControl({ type: "cockpit-running", sessionId, running });
  }

  attachRendererPort(port: MessagePortMain): void {
    const connection = this.connection;
    if (!connection || this.status !== "ready") {
      port.close();
      return;
    }
    const remotePort = connection.createChannel();
    const onLocalMessage = (event: { data: unknown }) => remotePort.postMessage(event.data);
    const onRemoteMessage = (event: { data: unknown }) => {
      try {
        port.postMessage(event.data);
      } catch {
        bridge.close();
      }
    };
    let closed = false;
    const bridge: RendererBridge = {
      localPort: port,
      remotePort,
      close: () => {
        if (closed) return;
        closed = true;
        port.off("message", onLocalMessage);
        port.off("close", bridge.close);
        remotePort.removeEventListener("message", onRemoteMessage);
        remotePort.removeEventListener("close", bridge.close);
        remotePort.close();
        port.close();
        this.rendererBridges.delete(bridge);
      },
    };
    port.on("message", onLocalMessage);
    port.on("close", bridge.close);
    remotePort.addEventListener("message", onRemoteMessage);
    remotePort.addEventListener("close", bridge.close);
    port.start();
    remotePort.start();
    this.rendererBridges.add(bridge);
  }

  createRendererChannel(): { port1: MessagePortMain; port2: MessagePortMain } {
    const { port1, port2 } = new MessageChannelMain();
    this.attachRendererPort(port2);
    return { port1, port2 };
  }

  call<T>(method: string, params?: unknown, timeoutMs = 10_000): Promise<T> {
    if (this.status !== "ready" || !this.connection) {
      return Promise.reject(new Error("Agent Host is not ready"));
    }
    const port = this.connection.createChannel();
    const id = `main-${randomUUID()}`;
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        port.removeEventListener("message", onMessage);
        port.close();
      };
      const onMessage = (event: { data: unknown }) => {
        const message = event.data as {
          kind?: string;
          id?: string;
          ok?: boolean;
          result?: T;
          error?: { message?: string };
        };
        if (message.kind !== "response" || message.id !== id) return;
        cleanup();
        if (message.ok) resolve(message.result as T);
        else reject(new Error(message.error?.message ?? `Host RPC failed: ${method}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Host RPC timed out: ${method}`));
      }, timeoutMs);
      port.addEventListener("message", onMessage);
      port.start();
      port.postMessage({ kind: "request", id, method, params });
    });
  }

  private setStatus(status: HostStatus, detail?: string): void {
    this.status = status;
    this.onStatusChange?.(status, detail);
  }

  private async connectOrLaunch(): Promise<void> {
    if (this.stopped || this.connection) return;
    const startedAt = Date.now();
    for (;;) {
      if (this.stopped || this.connection) return;
      try {
        const connection = await connectStandaloneHost(this.userDataDirectory, {
          clientVersion: this.hostVersion,
          timeoutMs: 1_000,
        });
        this.acceptConnection(connection);
        return;
      } catch (error) {
        const value = error as Error & { code?: string; hostProtocolVersion?: number };
        if (value.code === "PROTOCOL_MISMATCH") {
          this.setStatus(
            "starting",
            `Agent Host protocol ${value.hostProtocolVersion ?? "unknown"} is finishing active work; waiting to start the new version`,
          );
          this.scheduleReconnect();
          return;
        }
        const discovery = readHostDiscovery(this.userDataDirectory);
        if (discovery && processIsAlive(discovery.pid)) {
          if (Date.now() - startedAt < START_TIMEOUT_MS) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
          this.setStatus("crashed", `Agent Host did not accept connections: ${value.message}`);
          this.scheduleReconnect();
          return;
        }
        this.removeStaleDiscovery();
        if (this.externallySupervised) {
          if (Date.now() - startedAt < START_TIMEOUT_MS) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
          this.setStatus("starting", "Waiting for the development Agent Host supervisor");
          this.scheduleReconnect();
          return;
        }
        if (!this.launchAttempted) {
          this.launchAttempted = true;
          this.launchHost();
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        if (Date.now() - startedAt < START_TIMEOUT_MS) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        this.setStatus("crashed", `Agent Host failed to start: ${value.message}`);
        this.scheduleReconnect();
        return;
      }
    }
  }

  private launchHost(): void {
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.environment)) {
      if (typeof value === "string") environment[key] = value;
    }
    environment.ELECTRON_RUN_AS_NODE = "1";
    environment.PI_AGENT_HOST = "1";
    environment.PI_DESKTOP_USER_DATA = this.userDataDirectory;
    environment.PI_DESKTOP_VERSION = this.hostVersion;
    const child = spawn(this.executable, [this.hostEntry], {
      detached: true,
      env: environment,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error) => {
      appendMainLog(`agent-host spawn failed: ${error.message}`);
    });
    child.unref();
    appendMainLog(`standalone agent-host launch requested: ${this.hostEntry}`);
  }

  private acceptConnection(connection: StandaloneHostConnection): void {
    if (this.stopped) {
      connection.close();
      return;
    }
    this.connection = connection;
    this.launchAttempted = false;
    this.piVersion = connection.piVersion;
    this.toolchainAckRevision = -1;
    this.browserAckRevision = -1;
    this.lastPong = Date.now();
    const reconnectReason = this.reconnectReason;
    this.reconnectReason = null;
    connection.onControl((message) => this.handleControl(message));
    connection.onClose(() => this.handleConnectionClosed(connection));
    this.postToolchainSnapshot("toolchain:init");
    this.postBrowserSnapshot("browser:init");
    if (connection.hostVersion !== this.hostVersion) {
      connection.sendControl({ type: "replace-when-idle", expectedHostVersion: this.hostVersion });
    }
    this.setStatus("ready");
    this.startPing();
    this.onHostMessage?.({ type: "ready", ts: Date.now(), piVersion: this.piVersion ?? undefined });
    if (reconnectReason) {
      this.onHostMessage?.({ type: "host-restarted", reason: reconnectReason });
    }
    void this.call<{ count: number; sessionIds: string[] }>("system.runningCount")
      .then((result) => {
        this.runningSessionIds = new Set(result.sessionIds);
        this.onHostMessage?.({ type: "running-sessions", sessionIds: result.sessionIds });
      })
      .catch(() => undefined);
  }

  private handleConnectionClosed(connection: StandaloneHostConnection): void {
    if (this.connection !== connection) return;
    this.connection = null;
    this.clearPing();
    this.bashChildPids.clear();
    for (const bridge of this.rendererBridges) bridge.close();
    this.rendererBridges.clear();
    if (this.stopped) return;
    const interrupted = this.runningSessionIds.size > 0;
    this.reconnectReason = interrupted ? "crash-recovery" : "connection-recovery";
    this.runningSessionIds.clear();
    if (interrupted) {
      this.setStatus("crashed", "Agent Host exited while work was active; the task was interrupted; reconnecting");
    } else {
      this.setStatus("starting", "Agent Host connection closed; reconnecting");
    }
    this.scheduleReconnect();
  }

  private handleControl(value: unknown): void {
    const message = value as HostMessage;
    if (!message || typeof message.type !== "string") return;
    if (message.type === "pong") {
      this.lastPong = Date.now();
    } else if (message.type === "bash-child") {
      const pid = Number(message.pid);
      if (Number.isSafeInteger(pid) && pid > 0) {
        if (message.alive) this.bashChildPids.add(pid);
        else this.bashChildPids.delete(pid);
      }
    } else if (message.type === "log") {
      appendMainLog(`[host] ${String(message.message ?? "")}`);
    } else if (message.type === "running-sessions") {
      const sessionIds = Array.isArray(message.sessionIds)
        ? message.sessionIds.filter((value): value is string => typeof value === "string" && value.length > 0)
        : [];
      this.runningSessionIds = new Set(sessionIds);
    } else if (message.type === "toolchain:ack") {
      const revision = Number(message.revision);
      if (Number.isSafeInteger(revision) && revision >= 0) {
        this.toolchainAckRevision = Math.max(this.toolchainAckRevision, revision);
      }
    } else if (message.type === "browser:ack") {
      const revision = Number(message.revision);
      if (Number.isSafeInteger(revision) && revision >= 0) {
        this.browserAckRevision = Math.max(this.browserAckRevision, revision);
      }
    } else if (message.type === "host-rpc") {
      void this.handleHostRequest(message);
    }
    this.onHostMessage?.(message);
  }

  private async handleHostRequest(message: HostMessage): Promise<void> {
    const connection = this.connection;
    const request = message as HostMessage & { id?: unknown; method?: unknown; params?: unknown };
    const id = String(request.id ?? "");
    const method = String(request.method ?? "");
    if (!connection || !id || !method) return;
    try {
      if (!this.requestHandler) throw new Error("Main request handler is unavailable");
      const result = await this.requestHandler(method, request.params);
      connection.sendControl({ type: "host-rpc-result", id, ok: true, result });
    } catch (error) {
      connection.sendControl({
        type: "host-rpc-result",
        id,
        ok: false,
        error:
          error instanceof BrowserError
            ? error.toJSON()
            : { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.launchAttempted = false;
      void this.connectOrLaunch();
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref();
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      const connection = this.connection;
      if (!connection) return;
      if (Date.now() - this.lastPong > PING_TIMEOUT_MS + PING_INTERVAL_MS) {
        appendMainLog("agent-host ping timeout — reconnecting");
        connection.close();
        return;
      }
      connection.sendControl({ type: "ping" });
    }, PING_INTERVAL_MS);
  }

  private postToolchainSnapshot(type: "toolchain:init" | "toolchain:changed"): void {
    if (!this.connection || !this.toolchainSnapshot) return;
    this.connection.sendControl({ type, snapshot: this.toolchainSnapshot });
  }

  private postBrowserSnapshot(type: "browser:init" | "browser:changed"): void {
    if (!this.connection || !this.browserCapabilitySnapshot) return;
    this.connection.sendControl({ type, snapshot: this.browserCapabilitySnapshot });
  }

  private removeStaleDiscovery(): void {
    const discoveryPath = path.join(this.userDataDirectory, HOST_DISCOVERY_FILE);
    try {
      fs.rmSync(discoveryPath, { force: true });
    } catch {
      /* a racing Host may replace the record */
    }
  }

  private clearPing(): void {
    if (!this.pingTimer) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private clearReconnect(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

export function resolveHostEntry(mainDirectory = __dirname): string {
  return path.join(mainDirectory, "agent-host.mjs");
}

export function resolvePreloadPath(mainDirectory = __dirname): string {
  return path.join(mainDirectory, "..", "preload", "preload.js");
}

export function resolveRendererEntry(isDev: boolean, mainDirectory = __dirname): string {
  if (process.env.VITE_DEV_SERVER_URL) return process.env.VITE_DEV_SERVER_URL;
  const builtIndex = path.join(mainDirectory, "..", "renderer", "index.html");
  if (fs.existsSync(builtIndex)) return "app://bundle/index.html";
  if (isDev) return "http://localhost:5173";
  return "app://bundle/index.html";
}

export function getUserDataPath(...parts: string[]): string {
  return path.join(app.getPath("userData"), ...parts);
}
