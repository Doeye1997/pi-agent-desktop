import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TUI_RUNNING_REPORTER_SOURCE,
  createTuiRunningReporterChannel,
  overlayDockUsage,
  readTuiRunningMark,
  tuiRunningMarkPath,
  tuiUsageMarkPath,
  writeTuiRunningReporter,
} from "./tui-running-protocol.ts";

test("reporter source writes agent-turn marks to a file, not PTY OSC", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tui-running-"));
  const path = writeTuiRunningReporter(dir);
  assert.equal(readFileSync(path, "utf8"), TUI_RUNNING_REPORTER_SOURCE);
  assert.match(TUI_RUNNING_REPORTER_SOURCE, /agent_start/);
  assert.match(TUI_RUNNING_REPORTER_SOURCE, /agent_settled/);
  assert.match(TUI_RUNNING_REPORTER_SOURCE, /PI_DESKTOP_RUNNING_DIR/);
  assert.match(TUI_RUNNING_REPORTER_SOURCE, /ctx\.ui\.setStatus/);
  assert.match(TUI_RUNNING_REPORTER_SOURCE, /pi-grok-usage|grok\|usage/);
  assert.match(TUI_RUNNING_REPORTER_SOURCE, /\.usage/);
  assert.doesNotMatch(TUI_RUNNING_REPORTER_SOURCE, /pi-desktop-running;/);
});

test("launcher injects the reporter extension and session id", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tui-launcher-"));
  const channel = createTuiRunningReporterChannel({
    directory: dir,
    onRunning() {},
  });
  const launcher = channel.wrapProgram("F:/bundled/pi-cli.js", "sess 1");
  const source = readFileSync(launcher, "utf8");
  assert.match(source, /--extension/);
  assert.match(source, /PI_DESKTOP_SESSION_ID = "sess 1"/);
  assert.match(source, /F:\/bundled\/pi-cli\.js/);
  channel.dispose();
});

test("mark watcher reports 1 then 0 for a live session id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tui-watch-"));
  const seen = [];
  const channel = createTuiRunningReporterChannel({
    directory: dir,
    onRunning(sessionId, running) {
      seen.push([sessionId, running]);
    },
  });
  const sessionId = "sess-watch";
  writeFileSync(tuiRunningMarkPath(dir, sessionId), "1");
  await waitFor(() => seen.some((entry) => entry[0] === sessionId && entry[1] === true));
  writeFileSync(tuiRunningMarkPath(dir, sessionId), "0");
  await waitFor(() => seen.some((entry) => entry[0] === sessionId && entry[1] === false));
  assert.equal(readTuiRunningMark(dir, sessionId), false);
  channel.clear(sessionId);
  channel.dispose();
});

test("usage watcher overlays grok status onto dock state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tui-usage-"));
  const seen = [];
  const channel = createTuiRunningReporterChannel({
    directory: dir,
    onRunning() {},
    onUsage(sessionId, usageLabel) {
      seen.push([sessionId, usageLabel]);
    },
  });
  const sessionId = "sess-usage";
  writeFileSync(tuiUsageMarkPath(dir, sessionId), "SuperGrok 56.7% (7/20 14:00)");
  await waitFor(() => seen.some((entry) => entry[0] === sessionId && entry[1].includes("SuperGrok")));
  assert.equal(
    overlayDockUsage({ usageLabel: "Usage —" }, "SuperGrok 56.7% (7/20 14:00)").usageLabel,
    "SuperGrok 56.7% (7/20 14:00)",
  );
  channel.clear(sessionId);
  channel.dispose();
});

function waitFor(check, timeoutMs = 1000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("timed out waiting for running mark"));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}
