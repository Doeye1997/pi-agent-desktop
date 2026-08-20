import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.join(import.meta.dirname, "ipc.ts"), "utf8");

test("PTY-alive display marks do not union into sidebar runningSessionIds", () => {
  assert.match(source, /onMark\([^)]*\) \{\s*emitSessionDisplayMarks\(\);/);
  assert.equal(source.includes("setCockpitRunning"), false);
});
