import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createSessionDisplayService } from "./session-display-service.ts";
import { tuiUsageMarkPath } from "../main/fork/tui-running-protocol.ts";

function fakeNativeHost() {
  const calls = [];
  return {
    calls,
    mount: (request) => calls.push(["mount", request]),
    attach: (parentWindowHandle) => calls.push(["attach", parentWindowHandle]),
    detach: () => calls.push(["detach"]),
    focus: (sessionId) => calls.push(["focus", sessionId]),
    write: () => undefined,
    resize: () => undefined,
    setBounds: () => undefined,
    setTheme: () => undefined,
    setDockState: (sessionId, state) => calls.push(["dock", sessionId, state]),
    hide: () => undefined,
    dead: () => undefined,
    kill: () => undefined,
    dispose: () => calls.push(["dispose"]),
  };
}

test("Agent Host owns one native TUI while Electron clients detach and reattach", async (t) => {
  const runningDirectory = mkdtempSync(path.join(tmpdir(), "pi-display-service-"));
  const host = fakeNativeHost();
  const service = createSessionDisplayService({
    createHost: () => host,
    runningDirectory,
    emit: () => undefined,
    onRunning: () => undefined,
  });
  t.after(() => {
    service.dispose();
    rmSync(runningDirectory, { recursive: true, force: true });
  });
  const session = {
    sessionId: "session-1",
    cwd: "F:/project",
    nodeExecutable: "C:/node.exe",
    program: "F:/pi-cli.js",
  };

  service.handle({ type: "start", session, parentWindowHandle: "old-hwnd" });
  assert.equal(service.hasLiveSessions(), true);
  assert.deepEqual(service.snapshotStates(), { "session-1": "running-attached" });
  await service.handle({ type: "detach" });
  assert.deepEqual(service.snapshotStates(), { "session-1": "running-detached" });
  service.handle({ type: "start", session, parentWindowHandle: "new-hwnd" });
  assert.deepEqual(service.snapshotStates(), { "session-1": "running-attached" });

  assert.deepEqual(host.calls.map(([operation]) => operation), ["mount", "detach", "attach", "focus"]);
  assert.equal(host.calls.filter(([operation]) => operation === "mount").length, 1);
  assert.equal(host.calls.some(([operation]) => operation === "dispose"), false);
  service.handle({ type: "kill", sessionId: session.sessionId });
  assert.deepEqual(service.snapshotStates(), { "session-1": "exited" });
});

test("display control requests are generation-fenced and idempotent", async (t) => {
  const runningDirectory = mkdtempSync(path.join(tmpdir(), "pi-display-idempotent-"));
  const host = fakeNativeHost();
  const service = createSessionDisplayService({
    createHost: () => host,
    runningDirectory,
    generation: 7,
    emit: () => undefined,
    onRunning: () => undefined,
  });
  t.after(() => {
    service.dispose();
    rmSync(runningDirectory, { recursive: true, force: true });
  });
  const request = {
    requestId: "request-1",
    generation: 7,
    command: {
      type: "start",
      session: {
        sessionId: "session-idempotent",
        cwd: "F:/project",
        nodeExecutable: "C:/node.exe",
        program: "F:/pi-cli.js",
      },
      parentWindowHandle: "hwnd",
    },
  };

  assert.deepEqual(await service.execute(request), { requestId: "request-1", generation: 7, ok: true });
  assert.deepEqual(await service.execute(request), { requestId: "request-1", generation: 7, ok: true });
  assert.equal(host.calls.filter(([operation]) => operation === "mount").length, 1);
  assert.deepEqual(await service.execute({ ...request, requestId: "request-old", generation: 6 }), {
    requestId: "request-old",
    generation: 6,
    ok: false,
    message: "Session display request generation 6 does not match owner generation 7",
  });
});

test("failed detach reports an orphaned session without crashing the Host", async (t) => {
  const runningDirectory = mkdtempSync(path.join(tmpdir(), "pi-display-detach-failure-"));
  const host = fakeNativeHost();
  host.detach = () => Promise.reject(new Error("native detach failed"));
  const service = createSessionDisplayService({
    createHost: () => host,
    runningDirectory,
    generation: 12,
    emit: () => undefined,
    onRunning: () => undefined,
  });
  t.after(() => {
    service.dispose();
    rmSync(runningDirectory, { recursive: true, force: true });
  });
  service.handle({
    type: "start",
    session: {
      sessionId: "session-detach-failure",
      cwd: "F:/project",
      nodeExecutable: "C:/node.exe",
      program: "F:/pi-cli.js",
    },
    parentWindowHandle: "hwnd",
  });

  assert.deepEqual(
    await service.execute({
      requestId: "request-detach-failure",
      generation: 12,
      command: { type: "detach" },
    }),
    {
      requestId: "request-detach-failure",
      generation: 12,
      ok: false,
      message: "native detach failed",
    },
  );
  assert.deepEqual(service.snapshotStates(), { "session-detach-failure": "orphaned" });
});

test("TUI grok usage file overlays the dock usage label", (t) => {
  const runningDirectory = mkdtempSync(path.join(tmpdir(), "pi-display-usage-"));
  const host = fakeNativeHost();
  const service = createSessionDisplayService({
    createHost: () => host,
    runningDirectory,
    emit: () => undefined,
    onRunning: () => undefined,
  });
  t.after(() => {
    service.dispose();
    rmSync(runningDirectory, { recursive: true, force: true });
  });
  const session = {
    sessionId: "session-grok",
    cwd: "F:/project",
    nodeExecutable: "C:/node.exe",
    program: "F:/pi-cli.js",
  };
  service.handle({ type: "start", session, parentWindowHandle: "hwnd" });
  writeFileSync(tuiUsageMarkPath(runningDirectory, session.sessionId), "SuperGrok 56.7% (7/20 14:00)");
  service.handle({
    type: "dock",
    sessionId: session.sessionId,
    state: {
      cwdLabel: "project",
      worktreeLabel: "main",
      usageLabel: "Usage —",
      modelLabel: "Grok",
      thinkingLabel: "Auto",
      mcpLabel: "MCP",
      cwdChoices: [],
      worktreeChoices: [],
      modelChoices: [],
      thinkingChoices: [],
      skillChoices: [],
    },
  });
  const dock = host.calls.filter((call) => call[0] === "dock").at(-1);
  assert.equal(dock?.[2].usageLabel, "SuperGrok 56.7% (7/20 14:00)");
});

test("native remount restores the last dock so the worktree chip survives host exit", (t) => {
  const runningDirectory = mkdtempSync(path.join(tmpdir(), "pi-display-dock-restore-"));
  const host = fakeNativeHost();
  let emit;
  const service = createSessionDisplayService({
    createHost: (onEvent) => {
      emit = onEvent;
      return host;
    },
    runningDirectory,
    emit: () => undefined,
    onRunning: () => undefined,
  });
  t.after(() => {
    service.dispose();
    rmSync(runningDirectory, { recursive: true, force: true });
  });
  const session = {
    sessionId: "session-wt",
    cwd: "F:/project",
    nodeExecutable: "C:/node.exe",
    program: "F:/pi-cli.js",
  };
  const dockState = {
    cwdLabel: "project",
    worktreeLabel: "feat/dock",
    usageLabel: "Usage —",
    modelLabel: "Grok",
    thinkingLabel: "Auto",
    mcpLabel: "MCP",
    cwdChoices: [],
    worktreeChoices: [{ label: "feat/dock", value: "F:/project-worktrees/feat" }],
    modelChoices: [],
    thinkingChoices: [],
    skillChoices: [],
  };
  service.handle({ type: "start", session, parentWindowHandle: "hwnd" });
  service.handle({ type: "dock", sessionId: session.sessionId, state: dockState });
  emit({ type: "host-error", code: "HOST_EXITED", message: "Windows Terminal XAML host exited" });
  service.handle({ type: "start", session, parentWindowHandle: "hwnd" });
  const dock = host.calls.filter((call) => call[0] === "dock").at(-1);
  assert.equal(dock?.[1], session.sessionId);
  assert.equal(dock?.[2].worktreeLabel, "feat/dock");
  assert.deepEqual(dock?.[2].worktreeChoices, dockState.worktreeChoices);
});
