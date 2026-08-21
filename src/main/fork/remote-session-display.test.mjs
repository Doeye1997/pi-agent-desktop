import assert from "node:assert/strict";
import test from "node:test";

import { createRemoteSessionDisplayManager } from "./remote-session-display.ts";

test("remote display sends TUI ownership to Agent Host and only detaches on Electron dispose", () => {
  const commands = [];
  const marks = [];
  const manager = createRemoteSessionDisplayManager({
    getParentWindowHandle: () => "replacement-hwnd",
    send: (command) => commands.push(command),
    onMark: (sessionId, mark) => marks.push([sessionId, mark]),
  });
  const session = {
    sessionId: "session-1",
    cwd: "F:/project",
    nodeExecutable: "C:/node.exe",
    program: "F:/pi-cli.js",
  };

  assert.equal(manager.start(session).action, "spawn");
  manager.handleHostEvent({ type: "marks", marks: { "session-1": "running" } });
  manager.dispose();

  assert.deepEqual(commands, [
    { type: "start", session, parentWindowHandle: "replacement-hwnd", size: undefined, remount: false },
    { type: "detach" },
  ]);
  assert.deepEqual(marks, [["session-1", "running"]]);
  assert.deepEqual(manager.snapshotMarks(), { "session-1": "running" });
});
