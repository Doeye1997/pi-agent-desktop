import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startStandaloneHostServer } from "../agent-host/standalone-host-server.ts";
import { createRpcServer } from "../contract/rpc.ts";

const { HostManager } = await importTestBundle("src/main/host-manager-lifecycle", {
  stdin: {
    contents: 'export { HostManager } from "./host-manager.ts";',
    resolveDir: import.meta.dirname,
    sourcefile: "host-manager-lifecycle-entry.ts",
    loader: "ts",
  },
  plugins: [
    {
      name: "electron-host-manager-mock",
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "host-manager-test" }));
        builder.onLoad({ filter: /.*/, namespace: "host-manager-test" }, () => ({
          contents: `
            export const app = {
              getPath() { return process.cwd(); },
              getVersion() { return "test"; },
              isPackaged: false,
            };
            export class MessageChannelMain {}
          `,
          loader: "js",
        }));
      },
    },
  ],
});

async function waitFor(predicate, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test("HostManager reports interrupted work and tells Renderer to rebuild RPC after reconnect", async (t) => {
  const userDataDirectory = mkdtempSync(path.join(tmpdir(), "pi-host-manager-lifecycle-"));
  const statuses = [];
  const messages = [];
  let server = await startStandaloneHostServer({
    userDataDirectory,
    hostVersion: "test",
    rpcServer: createRpcServer(),
    isBusy: () => true,
  });
  const manager = new HostManager("unused", {
    userDataDirectory,
    hostVersion: "test",
    environment: { PI_DESKTOP_HOST_EXTERNAL_SUPERVISOR: "1" },
  });
  manager.setStatusListener((status, detail) => statuses.push({ status, detail }));
  manager.setMessageListener((message) => messages.push(message));
  manager.start();
  t.after(async () => {
    await manager.stop();
    await server.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  });

  await waitFor(() => manager.getStatus() === "ready", "initial Host connection");
  server.broadcastControl({ type: "running-sessions", sessionIds: ["active-session"] });
  await new Promise((resolve) => setTimeout(resolve, 25));
  await server.close();
  await waitFor(() => statuses.some((value) => value.status === "crashed"), "interrupted status");

  server = await startStandaloneHostServer({
    userDataDirectory,
    hostVersion: "test",
    rpcServer: createRpcServer(),
    isBusy: () => false,
  });
  await waitFor(() => manager.getStatus() === "ready", "replacement Host connection");
  assert.equal(
    messages.some((message) => message.type === "host-restarted" && message.reason === "crash-recovery"),
    true,
  );
});

test("HostManager reconnects the Electron display client to the persistent Host", async (t) => {
  const userDataDirectory = mkdtempSync(path.join(tmpdir(), "pi-host-display-lifecycle-"));
  const controls = [];
  const events = [];
  const server = await startStandaloneHostServer({
    userDataDirectory,
    hostVersion: "test",
    rpcServer: createRpcServer(),
    isBusy: () => true,
    onControl: (message) => controls.push(message),
  });
  const manager = new HostManager("unused", {
    userDataDirectory,
    hostVersion: "test",
    environment: { PI_DESKTOP_HOST_EXTERNAL_SUPERVISOR: "1" },
  });
  manager.setSessionDisplayEventListener((event) => events.push(event));
  manager.sendSessionDisplayCommand({ type: "hide", sessionId: "queued-session" });
  manager.start();
  t.after(async () => {
    await manager.stop();
    await server.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  });

  await waitFor(() => manager.getStatus() === "ready", "display Host connection");
  await waitFor(
    () =>
      controls.some(
        (message) => message.type === "session-display-request" && message.request?.command?.type === "sync",
      ),
    "display state sync",
  );
  await waitFor(
    () =>
      controls.some(
        (message) =>
          message.type === "session-display-request" &&
          message.request?.command?.type === "hide" &&
          message.request.command.sessionId === "queued-session",
      ),
    "queued display command",
  );
  const detachPromise = manager.detachSessionDisplays();
  await waitFor(
    () =>
      controls.some(
        (message) =>
          message.type === "session-display-request" &&
          message.request?.command?.type === "detach" &&
          typeof message.request.requestId === "string",
      ),
    "display detach",
  );
  const detachRequest = controls.findLast(
    (message) => message.type === "session-display-request" && message.request?.command?.type === "detach",
  );
  server.broadcastControl({
    type: "session-display-result",
    result: {
      requestId: detachRequest.request.requestId,
      generation: server.generation,
      ok: true,
    },
  });
  await detachPromise;

  server.broadcastControl({
    type: "session-display-event",
    event: { type: "marks", marks: { "tui-session": "running" } },
  });
  await waitFor(() => events.length === 1, "display event forwarding");
  assert.deepEqual(events[0], { type: "marks", marks: { "tui-session": "running" } });
});

test("HostManager uses the supervisor's development Host version", async (t) => {
  const userDataDirectory = mkdtempSync(path.join(tmpdir(), "pi-host-version-lifecycle-"));
  const controls = [];
  const server = await startStandaloneHostServer({
    userDataDirectory,
    hostVersion: "dev-generation-42",
    rpcServer: createRpcServer(),
    isBusy: () => true,
    onControl: (message) => controls.push(message),
  });
  const manager = new HostManager("missing-agent-host.mjs", {
    userDataDirectory,
    environment: {
      PI_DESKTOP_HOST_EXTERNAL_SUPERVISOR: "1",
      PI_DESKTOP_VERSION: "dev-generation-42",
    },
  });
  manager.start();
  t.after(async () => {
    await manager.stop();
    await server.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  });

  await waitFor(() => manager.getStatus() === "ready", "development Host connection");
  assert.equal(
    controls.some((message) => message?.type === "replace-when-idle"),
    false,
  );
});
