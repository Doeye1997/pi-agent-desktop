/**
 * Standalone Agent Host entry.
 * Runs pi-coding-agent in-process and accepts reconnectable Electron clients.
 */
import { createRpcServer } from "../contract/rpc";
import type { BrowserCapabilitySnapshot } from "../contract/browser";
import type { ToolchainSnapshot } from "../shared/toolchains/types";
import { browserCapabilityRuntime } from "./browser-capability-runtime";
import { setBashChildListener } from "./desktop-bash-exec";
import { installFetchBodyAbort } from "./fetch-abort";
import { registerHandlers } from "./handlers";
import { configureHostControl, postHostMessage, receiveMainControlMessage } from "./host-control";
import { installHttpIdleTimeout } from "./http-idle-timeout";
import {
  abortLiveRpcSession,
  getRunningSessionIds,
  setCockpitRunning,
  subscribeRunningSessions,
  syncBrowserToolsForAllSessions,
} from "./rpc-manager";
import { readPiRuntimeVersion } from "./runtime-version";
import { startSessionWatcher } from "./session-watcher";
import { startStandaloneHostServer, type StandaloneHostServer } from "./standalone-host-server";
import { installToolchainGitRunner } from "./toolchain-git";
import { toolchainRuntime } from "./toolchain-runtime";

const userDataDirectory = process.env.PI_DESKTOP_USER_DATA;
if (!userDataDirectory) throw new Error("PI_DESKTOP_USER_DATA is required");

const piRuntimeVersion = readPiRuntimeVersion();
const hostVersion = process.env.PI_DESKTOP_VERSION?.trim() || "0.0.0";
const standaloneState: { server?: StandaloneHostServer } = {};
let resolveStandaloneServer: (server: StandaloneHostServer) => void = () => undefined;
const standaloneServerReady = new Promise<StandaloneHostServer>((resolve) => {
  resolveStandaloneServer = resolve;
});

configureHostControl({
  broadcast: (message) => standaloneState.server?.broadcastControl(message),
  sendToMain: async (message, timeoutMs) => {
    const server = standaloneState.server ?? (await standaloneServerReady);
    await server.sendControlWhenConnected(message, timeoutMs);
  },
});

function log(message: string): void {
  postHostMessage({ type: "log", message });
  console.log(`[agent-host] ${message}`);
}

const httpIdleTimeoutMs = await installHttpIdleTimeout();
installFetchBodyAbort();
setBashChildListener((pid, alive) => {
  postHostMessage({ type: "bash-child", pid, alive });
});
log(`HTTP idle timeout ${httpIdleTimeoutMs}ms`);

const rpcServer = createRpcServer();
const restoreGitRunner = installToolchainGitRunner();
const stopHandlers = registerHandlers(rpcServer);
const stopWatcher = startSessionWatcher(rpcServer);
let resourcesStopped = false;

async function stopResources(): Promise<void> {
  if (resourcesStopped) return;
  resourcesStopped = true;
  stopWatcher();
  restoreGitRunner();
  await stopHandlers();
}

function handleMainControl(value: unknown): void {
  const message = value as {
    type?: string;
    sessionId?: string;
    running?: boolean;
    snapshot?: ToolchainSnapshot | BrowserCapabilitySnapshot;
  };
  if (message?.type === "host-rpc-result") {
    receiveMainControlMessage(message);
    return;
  }
  if (message?.type === "ping") {
    postHostMessage({ type: "pong", ts: Date.now() });
    return;
  }
  if (message?.type === "session-abort") {
    const sessionId = typeof message.sessionId === "string" ? message.sessionId.trim() : "";
    if (!sessionId) return;
    const hit = abortLiveRpcSession(sessionId);
    log(`session-abort ${sessionId} ${hit ? "delivered" : "no-live-session"}`);
    return;
  }
  if (message?.type === "cockpit-running") {
    const sessionId = typeof message.sessionId === "string" ? message.sessionId.trim() : "";
    if (!sessionId) return;
    setCockpitRunning(sessionId, message.running === true);
    return;
  }
  if (message?.type === "replace-when-idle") {
    standaloneState.server?.requestExitWhenIdle();
    return;
  }
  if (message?.type === "toolchain:init" || message?.type === "toolchain:changed") {
    try {
      if (!message.snapshot) throw new Error("missing snapshot");
      const snapshot = message.snapshot as ToolchainSnapshot;
      toolchainRuntime.apply(snapshot);
      postHostMessage({ type: "toolchain:ack", revision: snapshot.revision });
      log(`toolchain ${message.type === "toolchain:init" ? "initialized" : "updated"} revision=${snapshot.revision}`);
    } catch (error) {
      log(`toolchain snapshot rejected: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  if (message?.type === "browser:init" || message?.type === "browser:changed") {
    try {
      if (!message.snapshot) throw new Error("missing snapshot");
      const snapshot = message.snapshot as BrowserCapabilitySnapshot;
      browserCapabilityRuntime.apply(snapshot);
      syncBrowserToolsForAllSessions();
      postHostMessage({ type: "browser:ack", revision: snapshot.revision });
      log(`browser ${message.type === "browser:init" ? "initialized" : "updated"} revision=${snapshot.revision}`);
    } catch (error) {
      log(`browser capability snapshot rejected: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const standaloneServer = await startStandaloneHostServer({
  userDataDirectory,
  hostVersion,
  piVersion: piRuntimeVersion,
  rpcServer,
  isBusy: () => getRunningSessionIds().length > 0,
  onControl: handleMainControl,
  onMainDisconnected: () => receiveMainControlMessage({ type: "main-disconnected" }),
  onExitRequested: async () => {
    await stopResources();
    setImmediate(() => process.exit(0));
  },
});
standaloneState.server = standaloneServer;
resolveStandaloneServer(standaloneServer);
subscribeRunningSessions(() => standaloneServer.notifyBusyChanged());
postHostMessage({ type: "ready", ts: Date.now(), piVersion: piRuntimeVersion });
log("agent-host ready");

process.on("uncaughtException", (error) => {
  log(`uncaughtException: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  setImmediate(() => process.exit(1));
});
process.on("unhandledRejection", (error) => {
  log(`unhandledRejection: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  setImmediate(() => process.exit(1));
});
