import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./EmbeddedPiTerminal.tsx", import.meta.url), "utf8");

test("session display uses one native surface hole for the selected Pi session", () => {
  assert.match(source, /data-session-display-hole/);
  assert.match(source, /session\.id/);
  assert.match(source, /setSessionDisplayBounds/);
  assert.match(source, /hideSessionDisplay/);
  assert.match(source, /setSessionDisplayTheme/);
  assert.match(source, /new ResizeObserver/);
  assert.doesNotMatch(source, /@xterm/);
  assert.doesNotMatch(source, /new Terminal/);
  assert.doesNotMatch(source, /onSessionTuiData/);
});

test("session display reports native host failures as a visible hard error", () => {
  assert.match(source, /onSessionDisplayError/);
  assert.match(source, /role="alert"/);
  assert.match(source, /Windows Terminal XAML host/);
});

test("session display keeps composer ownership native and does not overlay HTML on the HWND", () => {
  assert.doesNotMatch(source, /TuiDockComposer/);
  assert.doesNotMatch(source, /zIndex: 20/);
  assert.doesNotMatch(source, /xterm-helper-textarea/);
});

test("dock waits for worktrees and reuses the last list so the chip is not published empty", () => {
  assert.match(source, /lastWorktreesRef/);
  assert.match(source, /worktreesReady/);
  assert.match(source, /listWorktrees\(projectKey\)/);
  assert.match(source, /if \(!active \|\| selectedSessionId\.current !== session\.id \|\| !worktreesReady\) return/);
});
