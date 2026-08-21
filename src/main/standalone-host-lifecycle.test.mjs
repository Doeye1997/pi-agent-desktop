import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startStandaloneHostServer } from "../agent-host/standalone-host-server.ts";
import { createRpcClient, createRpcServer } from "../contract/rpc.ts";
import { connectStandaloneHost, readHostDiscovery } from "./standalone-host-client.ts";
import {
  RUNTIME_REGISTRY_FILE,
  createRuntimeOwner,
  readRuntimeRegistry,
  writeRuntimeRegistry,
} from "../shared/runtime-registry.ts";

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
  assert.equal(discovery.generation, 1);

  const discoveryPath = path.join(userDataDirectory, RUNTIME_REGISTRY_FILE);
  const registry = readRuntimeRegistry(userDataDirectory);
  assert.ok(registry);
  writeFileSync(
    discoveryPath,
    JSON.stringify({ ...registry, endpoint: { ...registry.endpoint, token: "incorrect-auth-token" } }),
  );
  await assert.rejects(connectStandaloneHost(userDataDirectory), (error) => error.code === "AUTH_FAILED");
  writeFileSync(
    discoveryPath,
    JSON.stringify({ ...registry, owner: { ...registry.owner, ownerToken: "wrong-owner-token-123456" } }),
  );
  await assert.rejects(connectStandaloneHost(userDataDirectory), (error) => error.code === "IDENTITY_MISMATCH");
  writeFileSync(discoveryPath, JSON.stringify(registry));
  await assert.rejects(
    connectStandaloneHost(userDataDirectory, { protocolVersion: discovery.protocolVersion + 1 }),
    (error) => error.code === "PROTOCOL_MISMATCH" && error.hostProtocolVersion === discovery.protocolVersion,
  );
  assert.equal(child.exitCode, null, `Host exited after rejected clients: ${stderr}`);

  const firstConnection = await connectStandaloneHost(userDataDirectory);
  assert.equal(firstConnection.identityVerified, true);
  assert.equal(firstConnection.generation, discovery.generation);
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
  assert.equal(existsSync(path.join(userDataDirectory, RUNTIME_REGISTRY_FILE)), false);
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

test("ambiguous live registry is fenced instead of adopted or killed by PID", async (t) => {
  const userDataDirectory = mkdtempSync(path.join(tmpdir(), "pi-standalone-host-ambiguous-"));
  t.after(() => rmSync(userDataDirectory, { recursive: true, force: true }));
  writeRuntimeRegistry(userDataDirectory, {
    owner: createRuntimeOwner({
      pid: process.pid,
      generation: 9,
      processStartedAt: "2026-08-21T04:00:00.000Z",
    }),
    endpoint: { port: 49999, token: "z".repeat(64) },
    protocolVersion: 1,
    hostVersion: "ambiguous",
    sessions: { alpha: "orphaned" },
  });

  await assert.rejects(
    startStandaloneHostServer({
      userDataDirectory,
      hostVersion: "replacement",
      rpcServer: createRpcServer(),
      isBusy: () => false,
    }),
    /RUNTIME_OWNER_AMBIGUOUS/,
  );
  assert.equal(readRuntimeRegistry(userDataDirectory)?.owner.generation, 9);
});

test("Host close terminates unauthenticated sockets", async (t) => {
  const userDataDirectory = mkdtempSync(path.join(tmpdir(), "pi-standalone-host-half-open-"));
  const server = await startStandaloneHostServer({
    userDataDirectory,
    hostVersion: "fixture",
    rpcServer: createRpcServer(),
    isBusy: () => false,
  });
  const socket = net.createConnection({ host: "127.0.0.1", port: server.port });
  t.after(() => {
    socket.destroy();
    rmSync(userDataDirectory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const socketClosed = new Promise((resolve) => socket.once("close", resolve));

  await Promise.race([
    server.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Host close timed out")), 1_000)),
  ]);
  await Promise.race([
    socketClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Socket close timed out")), 1_000)),
  ]);
});
