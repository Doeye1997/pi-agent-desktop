import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ipcSource = readFileSync(path.join(import.meta.dirname, "ipc.ts"), "utf8");
const serviceSource = readFileSync(
  path.join(import.meta.dirname, "../agent-host/session-display-service.ts"),
  "utf8",
);

test("Agent Host owns TUI running marks while Electron only forwards display commands", () => {
  assert.doesNotMatch(ipcSource, /createTuiRunningReporterChannel|tuiRunning\.wrapProgram/);
  assert.match(ipcSource, /sendSessionDisplayCommand\(command\)/);
  assert.match(
    serviceSource,
    /createTuiRunningReporterChannel\(\{[\s\S]*onRunning: options\.onRunning,[\s\S]*\}\)/,
  );
  assert.match(serviceSource, /program: tuiRunning\.wrapProgram\(command\.session\.program, command\.session\.sessionId\)/);
  assert.match(serviceSource, /options\.onRunning\(sessionId, false\)/);
});
