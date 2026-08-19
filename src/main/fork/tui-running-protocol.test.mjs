import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TUI_RUNNING_REPORTER_SOURCE,
  encodeTuiRunningMark,
  splitTuiRunningOutput,
  writeTuiRunningReporter,
} from "./tui-running-protocol.ts";

test("running marks strip out of PTY bytes and keep the last bit", () => {
  const chunk = `hello${encodeTuiRunningMark(true)}mid${encodeTuiRunningMark(false)}bye`;
  assert.deepEqual(splitTuiRunningOutput(chunk), { text: "hellomidbye", running: false });
  assert.deepEqual(splitTuiRunningOutput("plain"), { text: "plain" });
});

test("reporter source writes a loadable extension file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tui-running-"));
  const path = writeTuiRunningReporter(dir);
  assert.equal(readFileSync(path, "utf8"), TUI_RUNNING_REPORTER_SOURCE);
  assert.match(TUI_RUNNING_REPORTER_SOURCE, /agent_start/);
  assert.match(TUI_RUNNING_REPORTER_SOURCE, /agent_settled/);
});
