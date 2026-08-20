import assert from "node:assert/strict";
import test from "node:test";

import { createSessionDisplayManager } from "./session-display.ts";

function createFakeHost() {
  const calls = [];
  return {
    calls,
    mount(request) {
      calls.push(["mount", request]);
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

test("session display mounts once, focuses on repeat selection, and remounts after relocation", () => {
  const host = createFakeHost();
  const manager = createSessionDisplayManager({
    createHost: () => host,
    getParentWindowHandle: () => "hwnd:cockpit",
  });

  assert.equal(manager.start(request()).action, "spawn");
  assert.equal(manager.start(request()).action, "focus");
  assert.equal(manager.start(request({ cwd: "F:/project-two", sessionPath: "F:/PiData/moved.jsonl" })).action, "spawn");

  assert.equal(host.calls[0][0], "mount");
  assert.equal(host.calls[0][1].parentWindowHandle, "hwnd:cockpit");
  assert.deepEqual(host.calls[1], ["focus", "sess-1"]);
  assert.deepEqual(host.calls[2], ["kill", "sess-1"]);
  assert.equal(host.calls[3][0], "mount");
  assert.equal(host.calls[3][1].session.cwd, "F:/project-two");
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
