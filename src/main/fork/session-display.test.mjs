import assert from "node:assert/strict";
import test from "node:test";

import { createLatestSessionDisplayStarter, createSessionDisplayManager } from "./session-display.ts";

function createFakeHost() {
  const calls = [];
  return {
    calls,
    mount(request) {
      calls.push(["mount", request]);
    },
    attach(parentWindowHandle) {
      calls.push(["attach", parentWindowHandle]);
    },
    detach() {
      calls.push(["detach"]);
    },
    focus(sessionId) {
      calls.push(["focus", sessionId]);
    },
    write(sessionId, data) {
      calls.push(["write", sessionId, data]);
    },
    resize(sessionId, size) {
      calls.push(["resize", sessionId, size]);
    },
    setBounds(sessionId, bounds) {
      calls.push(["bounds", sessionId, bounds]);
    },
    setTheme(theme) {
      calls.push(["theme", theme]);
    },
    setDockState(sessionId, state) {
      calls.push(["dock", sessionId, state]);
    },
    hide(sessionId) {
      calls.push(["hide", sessionId]);
    },
    dead(sessionId) {
      calls.push(["dead", sessionId]);
    },
    kill(sessionId) {
      calls.push(["kill", sessionId]);
    },
    dispose() {
      calls.push(["dispose"]);
    },
  };
}

function request(overrides = {}) {
  return {
    sessionId: "sess-1",
    sessionPath: "F:/PiData/session-1.jsonl",
    cwd: "F:/project-one",
    nodeExecutable: "C:/Node/node.exe",
    program: "F:/bundled/pi-cli.js",
    ...overrides,
  };
}

test("sidebar switching focuses mounted sessions without killing their background terminals", () => {
  const host = createFakeHost();
  const manager = createSessionDisplayManager({
    createHost: () => host,
    getParentWindowHandle: () => "hwnd:cockpit",
  });

  assert.equal(manager.start(request()).action, "spawn");
  assert.equal(manager.start(request()).action, "focus");
  assert.equal(manager.start(request({ sessionId: "sess-2", cwd: "F:/project-two" })).action, "spawn");
  assert.equal(manager.start(request({ cwd: "F:/project-two", sessionPath: "F:/PiData/moved.jsonl" })).action, "focus");

  assert.equal(host.calls[0][0], "mount");
  assert.equal(host.calls[0][1].parentWindowHandle, "hwnd:cockpit");
  assert.deepEqual(host.calls[1], ["focus", "sess-1"]);
  assert.equal(host.calls[2][0], "mount");
  assert.equal(host.calls[2][1].session.sessionId, "sess-2");
  assert.deepEqual(host.calls[3], ["focus", "sess-1"]);
  assert.equal(host.calls.some(([operation]) => operation === "kill"), false);
});

test("explicit session relocation remounts only that session", () => {
  const host = createFakeHost();
  let emit;
  const manager = createSessionDisplayManager({
    createHost: (onEvent) => {
      emit = onEvent;
      return host;
    },
    getParentWindowHandle: () => "hwnd:cockpit",
  });
  manager.start(request());

  assert.equal(
    manager.start(request({ cwd: "F:/project-two", sessionPath: "F:/PiData/moved.jsonl" }), undefined, true).action,
    "spawn",
  );
  assert.deepEqual(host.calls.slice(1).map(([operation]) => operation), ["kill", "mount"]);
  manager.start(request({ cwd: "F:/project-three", sessionPath: "F:/PiData/moved-again.jsonl" }), undefined, true);
  emit({ type: "mark", sessionId: "sess-1", mark: "dead" });
  emit({ type: "mark", sessionId: "sess-1", mark: "dead" });
  assert.equal(manager.snapshotMarks()["sess-1"], "running");
  assert.equal(host.calls.some(([operation]) => operation === "dead"), false);
});

test("session display forwards composer, resize, native bounds, and theme operations", () => {
  const host = createFakeHost();
  const manager = createSessionDisplayManager({
    createHost: () => host,
    getParentWindowHandle: () => "hwnd:cockpit",
  });
  manager.start(request());

  manager.write("sess-1", "hello\r");
  manager.resize("sess-1", 120, 42);
  manager.setBounds("sess-1", { x: 4, y: 8, width: 640, height: 480, scaleFactor: 1.25 });
  manager.setTheme("light");

  assert.deepEqual(host.calls.slice(1), [
    ["write", "sess-1", "hello\r"],
    ["resize", "sess-1", { cols: 120, rows: 42 }],
    ["bounds", "sess-1", { x: 4, y: 8, width: 640, height: 480, scaleFactor: 1.25 }],
    ["theme", "light"],
  ]);
});

test("session display applies bounds published before an async session mount", () => {
  const host = createFakeHost();
  const manager = createSessionDisplayManager({
    createHost: () => host,
    getParentWindowHandle: () => "hwnd:cockpit",
  });
  const bounds = { x: 280, y: 48, width: 960, height: 720, scaleFactor: 1.25 };

  manager.setBounds("sess-1", bounds);
  manager.start(request());

  assert.deepEqual(host.calls, [
    ["mount", { session: request(), size: { cols: 120, rows: 30 }, parentWindowHandle: "hwnd:cockpit" }],
    ["bounds", "sess-1", bounds],
  ]);
});

test("session display ignores an older sidebar selection that resolves after the latest selection", async () => {
  const resolutions = new Map();
  const starts = [];
  const starter = createLatestSessionDisplayStarter({
    resolveNodeExecutable: (cwd) =>
      new Promise((resolve) => {
        resolutions.set(cwd, resolve);
      }),
    program: () => "F:/bundled/pi-cli.js",
    start: (session) => starts.push(session),
    onError: () => assert.fail("selection should not fail"),
  });

  const older = starter.start({ sessionId: "sess-1", cwd: "F:/project-one" });
  const latest = starter.start({ sessionId: "sess-2", cwd: "F:/project-two" });
  resolutions.get("F:/project-two")("C:/Node/latest.exe");
  await latest;
  resolutions.get("F:/project-one")("C:/Node/older.exe");
  await older;

  assert.deepEqual(starts, [
    {
      sessionId: "sess-2",
      cwd: "F:/project-two",
      nodeExecutable: "C:/Node/latest.exe",
      program: "F:/bundled/pi-cli.js",
    },
  ]);
});

test("session display stop cancels a selected session before its executable resolves", async () => {
  let resolveExecutable;
  const starts = [];
  const starter = createLatestSessionDisplayStarter({
    resolveNodeExecutable: () =>
      new Promise((resolve) => {
        resolveExecutable = resolve;
      }),
    program: () => "F:/bundled/pi-cli.js",
    start: (session) => starts.push(session),
    onError: () => assert.fail("cancelled selection should not fail"),
  });

  const pending = starter.start({ sessionId: "sess-1", cwd: "F:/project-one" });
  starter.cancel("sess-1");
  resolveExecutable("C:/Node/node.exe");
  await pending;

  assert.deepEqual(starts, []);
});

test("session display forwards dock state and returns native picker actions", () => {
  const host = createFakeHost();
  const actions = [];
  let emit;
  const manager = createSessionDisplayManager({
    createHost: (onEvent) => {
      emit = onEvent;
      return host;
    },
    getParentWindowHandle: () => "hwnd:cockpit",
    onAction: (action) => actions.push(action),
  });
  manager.start(request());

  const state = {
    cwdLabel: "project-one",
    worktreeLabel: "main",
    usageLabel: "Context 12k",
    modelLabel: "Sonnet",
    thinkingLabel: "High",
    mcpLabel: "MCP",
    cwdChoices: [{ label: "project-two", value: "F:/project-two" }],
    worktreeChoices: [],
    modelChoices: [],
    thinkingChoices: [],
    skillChoices: [],
  };
  manager.setDockState("sess-1", state);
  emit({ type: "action", sessionId: "sess-1", action: "relocate", value: "F:/project-two" });

  assert.deepEqual(host.calls.at(-1), ["dock", "sess-1", state]);
  assert.deepEqual(actions, [
    { type: "action", sessionId: "sess-1", action: "relocate", value: "F:/project-two" },
  ]);
});

test("session display hides a deselected native child without killing its background session", () => {
  const host = createFakeHost();
  const manager = createSessionDisplayManager({
    createHost: () => host,
    getParentWindowHandle: () => "hwnd:cockpit",
  });
  manager.start(request());

  manager.hide("sess-1");

  assert.deepEqual(host.calls.at(-1), ["hide", "sess-1"]);
  assert.equal(manager.snapshotMarks()["sess-1"], "running");
  assert.equal(host.calls.some(([type]) => type === "kill"), false);
});

test("composer seam forwards one complete Unicode line with CR", () => {
  const host = createFakeHost();
  const manager = createSessionDisplayManager({
    createHost: () => host,
    getParentWindowHandle: () => "hwnd:cockpit",
  });
  manager.start(request());

  manager.write("sess-1", "你好，Pi\r");

  const writes = host.calls.filter(([type]) => type === "write");
  assert.deepEqual(writes, [["write", "sess-1", "你好，Pi\r"]]);
  assert.equal(writes[0][2].endsWith("\r"), true);
});

test("missing Windows Terminal host becomes a dead mark and hard error without fallback", () => {
  const errors = [];
  const manager = createSessionDisplayManager({
    createHost: () => {
      throw new Error("Windows Terminal XAML host is unavailable");
    },
    getParentWindowHandle: () => "hwnd:cockpit",
    onError: (error) => errors.push(error),
  });

  const result = manager.start(request());

  assert.equal(result.action, "error");
  assert.equal(manager.snapshotMarks()["sess-1"], "dead");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "HOST_UNAVAILABLE");
  assert.match(errors[0].message, /Windows Terminal XAML host/);
});

test("native process exit preserves the mounted display for Enter restart", () => {
  const host = createFakeHost();
  let emit;
  const manager = createSessionDisplayManager({
    createHost: (onEvent) => {
      emit = onEvent;
      return host;
    },
    getParentWindowHandle: () => "hwnd:cockpit",
  });
  manager.start(request());

  emit({ type: "mark", sessionId: "sess-1", mark: "dead" });
  assert.equal(manager.snapshotMarks()["sess-1"], "dead");
  assert.deepEqual(host.calls.at(-1), ["dead", "sess-1"]);

  manager.write("sess-1", "\r");
  emit({ type: "mark", sessionId: "sess-1", mark: "running" });
  assert.deepEqual(host.calls.at(-1), ["write", "sess-1", "\r"]);
  assert.equal(manager.snapshotMarks()["sess-1"], "running");

  manager.dispose();
  assert.deepEqual(host.calls.at(-1), ["dispose"]);
  assert.deepEqual(manager.snapshotMarks(), {});
});

test("Electron replacement detaches native windows without disposing their TUI sessions", () => {
  const host = createFakeHost();
  const manager = createSessionDisplayManager({
    createHost: () => host,
    getParentWindowHandle: () => "hwnd:replacement",
  });
  manager.start(request());

  manager.detach();
  manager.attach();

  assert.deepEqual(host.calls.slice(1), [["detach"], ["attach", "hwnd:replacement"]]);
  assert.equal(manager.snapshotMarks()["sess-1"], "running");
  assert.equal(host.calls.some(([operation]) => operation === "dispose"), false);
});

test("stale Electron parent errors keep the live TUI available for reattach", () => {
  const host = createFakeHost();
  let emit;
  const manager = createSessionDisplayManager({
    createHost: (onEvent) => {
      emit = onEvent;
      return host;
    },
    getParentWindowHandle: () => "hwnd:replacement",
  });
  manager.start(request());

  emit({
    type: "host-error",
    code: "INVALID_PARENT_WINDOW",
    message: "failed to attach session host window to parent, error=1400",
  });
  manager.detach();
  manager.attach();
  manager.start(request());

  assert.equal(manager.snapshotMarks()["sess-1"], "running");
  assert.equal(host.calls.filter(([operation]) => operation === "mount").length, 1);
  assert.deepEqual(host.calls.slice(-3), [["detach"], ["attach", "hwnd:replacement"], ["focus", "sess-1"]]);
});
