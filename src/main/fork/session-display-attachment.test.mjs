import assert from "node:assert/strict";
import test from "node:test";

import { createLatestSessionDisplayStarter } from "./session-display-attachment.ts";

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
