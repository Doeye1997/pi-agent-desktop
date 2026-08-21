import assert from "node:assert/strict";
import test from "node:test";

import { EventEmitter } from "node:events";

import {
  createTsupWatchArgs,
  launchDetachedAgentHost,
  requestGracefulElectronRestart,
  superviseDetachedAgentHost,
  superviseRestartableProcess,
  waitForValidJavaScriptBundle,
  waitForViteReady,
} from "./dev.mjs";

test("development watch ignores source tests that cannot affect runtime bundles", () => {
  assert.deepEqual(createTsupWatchArgs("C:/project/tsup.js"), [
    "C:/project/tsup.js",
    "--config",
    "tsup.config.ts",
    "--watch",
    "src",
    "--watch",
    "tsup.config.ts",
    "--ignore-watch",
    "**/*.test.mjs",
  ]);
});

test("development launches Agent Host outside the supervised Electron process tree", () => {
  let spawnCall;
  let unrefCalls = 0;
  const child = {
    once() {},
    unref() {
      unrefCalls += 1;
    },
  };
  launchDetachedAgentHost("C:/project", "C:/profile", {
    nodeExecutable: "node.exe",
    hostEntry: "C:/project/out/main/agent-host.mjs",
    hostVersion: "build-42",
    spawn: (command, args, options) => {
      spawnCall = { command, args, options };
      return child;
    },
  });

  assert.equal(spawnCall.command, "node.exe");
  assert.deepEqual(spawnCall.args, ["C:/project/out/main/agent-host.mjs"]);
  assert.equal(spawnCall.options.detached, true);
  assert.equal(spawnCall.options.stdio, "ignore");
  assert.equal(spawnCall.options.env.PI_DESKTOP_USER_DATA, "C:/profile");
  assert.equal(spawnCall.options.env.PI_DESKTOP_VERSION, "build-42");
  assert.equal(unrefCalls, 1);
});

test("development can inherit detached Agent Host diagnostics", () => {
  let spawnOptions;
  launchDetachedAgentHost("C:/project", "C:/profile", {
    nodeExecutable: "node.exe",
    hostEntry: "C:/project/out/main/agent-host.mjs",
    hostVersion: "build-42",
    stdio: ["ignore", "inherit", "inherit"],
    spawn: (_command, _args, options) => {
      spawnOptions = options;
      return { once() {}, unref() {} };
    },
  });

  assert.deepEqual(spawnOptions.stdio, ["ignore", "inherit", "inherit"]);
});

test("development supervisor replaces an idle Host without making it an Electron child", () => {
  const children = [];
  const timers = [];
  const supervisor = superviseDetachedAgentHost({
    start: () => {
      const child = new EventEmitter();
      children.push(child);
      return child;
    },
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer() {},
  });

  children[0].emit("exit", 0, null);
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(children.length, 2);
  supervisor.dispose();
});

test("Vite readiness retries failures until an OK health response", async () => {
  let clock = 0;
  let calls = 0;
  await waitForViteReady("http://127.0.0.1:5173", {
    fetch: async () => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNREFUSED");
      return { ok: calls === 3, status: 503 };
    },
    now: () => clock,
    sleep: async (delay) => {
      clock += delay;
    },
    timeoutMs: 1_000,
    intervalMs: 100,
  });
  assert.equal(calls, 3);
  assert.equal(clock, 200);
});

test("Vite readiness has a total timeout with the last failure", async () => {
  let clock = 0;
  await assert.rejects(
    waitForViteReady("http://127.0.0.1:5173", {
      fetch: async () => ({ ok: false, status: 503 }),
      now: () => clock,
      sleep: async (delay) => {
        clock += delay;
      },
      timeoutMs: 250,
      intervalMs: 100,
    }),
    /within 250ms \(last failure: HTTP 503\)/,
  );
  assert.equal(clock, 250);
});

test("JavaScript bundle readiness retries while tsup is writing", async () => {
  let clock = 0;
  let reads = 0;
  await waitForValidJavaScriptBundle("main.js", {
    readFile: async () => {
      reads += 1;
      return reads === 1 ? "const broken =" : "const ready = true;";
    },
    now: () => clock,
    sleep: async (delay) => {
      clock += delay;
    },
    timeoutMs: 1_000,
    intervalMs: 100,
  });
  assert.equal(reads, 2);
  assert.equal(clock, 100);
});

test("JavaScript bundle readiness waits for the watch build", async () => {
  let clock = 0;
  let statCalls = 0;
  let reads = 0;
  await waitForValidJavaScriptBundle("main.js", {
    modifiedAfterMs: 100,
    stat: async () => {
      statCalls += 1;
      return { mtimeMs: statCalls === 1 ? 100 : 101 };
    },
    readFile: async () => {
      reads += 1;
      return "const ready = true;";
    },
    now: () => clock,
    sleep: async (delay) => {
      clock += delay;
    },
    timeoutMs: 1_000,
    intervalMs: 100,
  });
  assert.equal(statCalls, 2);
  assert.equal(reads, 1);
  assert.equal(clock, 100);
});

test("Electron supervisor debounces rebuilds and starts a replacement after exit", () => {
  const children = [];
  const stopped = [];
  const timers = new Map();
  let nextTimerId = 0;
  const supervisor = superviseRestartableProcess({
    start: () => {
      const child = new EventEmitter();
      children.push(child);
      return child;
    },
    stop: (child) => stopped.push(child),
    onUnexpectedExit: () => assert.fail("planned restart was treated as an unexpected exit"),
    setTimer: (callback) => {
      nextTimerId += 1;
      timers.set(nextTimerId, callback);
      return nextTimerId;
    },
    clearTimer: (timerId) => timers.delete(timerId),
  });

  supervisor.scheduleRestart();
  supervisor.scheduleRestart();
  assert.equal(timers.size, 1);
  timers.values().next().value();
  assert.deepEqual(stopped, [children[0]]);
  children[0].emit("exit", 1, null);
  assert.equal(children.length, 2);
  supervisor.dispose();
});

test("Electron supervisor reports an unplanned exit", () => {
  const child = new EventEmitter();
  let exitResult;
  const supervisor = superviseRestartableProcess({
    start: () => child,
    stop: () => assert.fail("stop should not run"),
    onUnexpectedExit: (result) => {
      exitResult = result;
    },
  });

  child.emit("exit", 7, null);
  assert.deepEqual(exitResult, { code: 7, signal: null });
  supervisor.dispose();
});

test("development restart asks Electron to quit before the process-tree fallback", async () => {
  const child = new EventEmitter();
  const writes = [];
  const terminated = [];
  const timers = new Map();
  let nextTimerId = 0;
  requestGracefulElectronRestart(child, "C:/profile/electron-restart.request", {
    writeFile: async (...args) => writes.push(args),
    terminate: (value) => terminated.push(value),
    setTimer: (callback) => {
      nextTimerId += 1;
      timers.set(nextTimerId, callback);
      return nextTimerId;
    },
    clearTimer: (timerId) => timers.delete(timerId),
  });
  await Promise.resolve();

  assert.equal(writes[0][0], "C:/profile/electron-restart.request");
  assert.equal(timers.size, 1);
  child.emit("exit", 0, null);
  assert.equal(timers.size, 0);
  assert.deepEqual(terminated, []);
});
