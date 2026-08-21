import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startStandaloneHostServer } from "../agent-host/standalone-host-server.ts";
import { createRpcClient, createRpcServer } from "../contract/rpc.ts";
import { connectStandaloneHost, readHostDiscovery } from "./standalone-host-client.ts";

async function waitFor(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test("active Host work survives Electron client replacement", async (t) => {
  const userDataDirectory = mkdtempSync(path.join(tmpdir(), "pi-standalone-host-"));
  const fixturePath = path.resolve("src/agent-host/standalone-host-fixture.ts");
  const child = spawn(process.execPath, ["--experimental-strip-types", fixturePath], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      PI_DESKTOP_USER_DATA: userDataDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  t.after(() => {
    child.kill();
    rmSync(userDataDirectory, { recursive: true, force: true });
  });

  const discovery = await waitFor(
    () => readHostDiscovery(userDataDirectory),
    `Host discovery record; stderr=${stderr}`,
  );
  assert.equal(discovery.pid, child.pid);

  const discoveryPath = path.join(userDataDirectory, "agent-host.json");
  writeFileSync(discoveryPath, JSON.stringify({ ...discovery, token: "incorrect-auth-token" }));
  await assert.rejects(connectStandaloneHost(userDataDirectory), (error) => error.code === "AUTH_FAILED");
  writeFileSync(discoveryPath, JSON.stringify(discovery));
  await assert.rejects(
    connectStandaloneHost(userDataDirectory, { protocolVersion: discovery.protocolVersion + 1 }),
    (error) => error.code === "PROTOCOL_MISMATCH" && error.hostProtocolVersion === discovery.protocolVersion,
  );
  assert.equal(child.exitCode, null, `Host exited after rejected clients: ${stderr}`);

  const firstConnection = await connectStandaloneHost(userDataDirectory);
  const firstClient = createRpcClient(firstConnection.createChannel());
  const pendingOperation = firstClient.call("fixture.hold", { value: "survived" });
  const pendingOperationClosed = assert.rejects(pendingOperation, /RPC port closed/);
  await waitFor(async () => {
    const status = await firstClient.call("fixture.status");
    return status.running === true;
  }, "fixture operation to start");

  firstClient.close();
  firstConnection.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null, `Host exited after first client: ${stderr}`);

  const secondConnection = await connectStandaloneHost(userDataDirectory);
  assert.equal(secondConnection.pid, discovery.pid);
  const secondClient = createRpcClient(secondConnection.createChannel());
  assert.deepEqual(await secondClient.call("fixture.status"), {
    running: true,
    result: null,
  });
  secondConnection.sendControl({ type: "replace-when-idle" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null, `Host replaced before active work finished: ${stderr}`);
  await secondClient.call("fixture.release");
  assert.deepEqual(await secondClient.call("fixture.status"), {
    running: false,
    result: "survived",
  });

  await pendingOperationClosed;
  await waitFor(() => child.exitCode !== null, "idle Host to exit");
  secondClient.close();
  secondConnection.close();
  assert.equal(child.exitCode, 0, stderr);
  assert.equal(existsSync(path.join(userDataDirectory, "agent-host.json")), false);
});

test("Electron-only Host work returns structured unavailable after its reconnect window", async (t) => {
  const userDataDirectory = mkdtempSync(path.join(tmpdir(), "pi-standalone-host-main-wait-"));
  writeFileSync(path.join(userDataDirectory, "agent-host.lock"), "2147483647");
  writeFileSync(path.join(userDataDirectory, "agent-host.json"), '{"stale":true}\n');
  const server = await startStandaloneHostServer({
    userDataDirectory,
    hostVersion: "fixture",
    rpcServer: createRpcServer(),
    isBusy: () => true,
  });
  assert.equal(readHostDiscovery(userDataDirectory)?.pid, process.pid);
  t.after(async () => {
    await server.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  });

  await assert.rejects(
    server.sendControlWhenConnected({ type: "host-rpc" }, 10),
    (error) => error.code === "ELECTRON_MAIN_UNAVAILABLE" && error.retryable === true && error.details?.waitedMs === 10,
  );
});

test("idle Host waits for Electron reconnect instead of exiting after the replacement delay", async (t) => {
  const userDataDirectory = mkdtempSync(path.join(tmpdir(), "pi-standalone-host-reconnect-"));
  let exited = false;
  const server = await startStandaloneHostServer({
    userDataDirectory,
    hostVersion: "fixture",
    rpcServer: createRpcServer(),
    isBusy: () => false,
    idleExitDelayMs: 50,
    startupGraceMs: 400,
    onExitRequested: () => {
      exited = true;
    },
  });
  t.after(async () => {
    await server.close();
    rmSync(userDataDirectory, { recursive: true, force: true });
  });

  const connection = await connectStandaloneHost(userDataDirectory);
  connection.close();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(exited, false, "Host must survive a short Electron disconnect without work");

  const reconnected = await connectStandaloneHost(userDataDirectory);
  assert.equal(reconnected.pid, process.pid);
  reconnected.close();
});
