import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.join(import.meta.dirname, "ipc.ts"), "utf8");

test("PTY-alive display marks do not union into sidebar runningSessionIds", () => {
  assert.doesNotMatch(source, /setCockpitRunning\(sessionId, mark === "running"\)/);
  assert.match(source, /onRunning\(sessionId, running\) \{\s*getHostManager\(\)\?\.setCockpitRunning\(sessionId, running\)/);
  assert.match(source, /if \(mark === "dead"\) \{[\s\S]*setCockpitRunning\(sessionId, false\)/);
  assert.match(source, /tuiRunning\.wrapProgram\(session\.program, session\.sessionId\)/);
});
