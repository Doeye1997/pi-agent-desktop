import assert from "node:assert/strict";
import test from "node:test";

import { buildSessionDisplayDockState, inputForSessionDisplayAction } from "./session-display-dock.ts";

test("dock state projects session facts and picker choices without reading terminal cells", () => {
  const state = buildSessionDisplayDockState({
    session: {
      id: "sess-1",
      path: "F:/sessions/one.jsonl",
      cwd: "F:/repo-worktrees/feature",
      projectRoot: "F:/repo",
      worktreeBranch: "feature/native-dock",
    },
    sessions: [
      { id: "sess-1", cwd: "F:/repo-worktrees/feature" },
      { id: "sess-2", cwd: "F:/other" },
    ],
    worktrees: [
      { path: "F:/repo", branch: "main", isMain: true },
      { path: "F:/repo-worktrees/feature", branch: "feature/native-dock", isMain: false },
    ],
    models: {
      models: [
        { id: "sonnet", name: "Claude Sonnet", provider: "anthropic" },
        { id: "gpt", name: "GPT", provider: "openai" },
      ],
      thinkingLevels: { "anthropic:sonnet": ["off", "medium", "high"] },
    },
    context: {
      model: { provider: "anthropic", modelId: "sonnet" },
      thinkingLevel: "high",
      messages: [
        {
          role: "assistant",
          usage: { input: 3000, output: 400, cacheRead: 100, cacheWrite: 0 },
        },
      ],
    },
    skills: [{ name: "review", description: "Review current changes" }],
    statuses: [
      { key: "mcp", text: "MCP: 2 connected" },
      { key: "pi-grok-usage", text: "SuperGrok 98%" },
    ],
  });

  assert.equal(state.cwdLabel, "feature");
  assert.equal(state.worktreeLabel, "feature/native-dock");
  assert.equal(state.usageLabel, "SuperGrok 98%");
  assert.equal(state.modelLabel, "Claude Sonnet");
  assert.equal(state.thinkingLabel, "High");
  assert.equal(state.mcpLabel, "MCP: 2 connected");
  assert.deepEqual(state.cwdChoices, [
    { label: "feature", value: "F:/repo-worktrees/feature" },
    { label: "other", value: "F:/other" },
  ]);
  assert.deepEqual(
    state.worktreeChoices.map(({ label }) => label),
    ["main", "feature/native-dock"],
  );
  assert.deepEqual(
    state.thinkingChoices.map(({ value }) => value),
    ["off", "medium", "high"],
  );
  assert.deepEqual(state.skillChoices, [{ label: "/review — Review current changes", value: "/review" }]);
});

test("dock worktree label uses the matching worktree branch, including main checkouts", () => {
  const main = buildSessionDisplayDockState({
    session: { id: "sess-main", cwd: "F:/repo", projectRoot: "F:/repo" },
    worktrees: [
      { path: "F:/repo", branch: "main", isMain: true },
      { path: "F:/repo-worktrees/feature", branch: "feature/x", isMain: false },
    ],
  });
  assert.equal(main.worktreeLabel, "main");

  const linked = buildSessionDisplayDockState({
    session: { id: "sess-wt", cwd: "F:/repo-worktrees/feature", projectRoot: "F:/repo" },
    worktrees: [
      { path: "F:/repo", branch: "main", isMain: true },
      { path: "F:/repo-worktrees/feature", branch: "feature/x", isMain: false },
    ],
  });
  assert.equal(linked.worktreeLabel, "feature/x");

  const unknown = buildSessionDisplayDockState({
    session: { id: "sess-plain", cwd: "F:/Project/dlyzzt-pi-desktop" },
  });
  assert.equal(unknown.worktreeLabel, "");
});

test("dock worktree choices list every local branch and keep existing worktree paths", () => {
  const state = buildSessionDisplayDockState({
    session: {
      id: "sess-1",
      cwd: "F:/repo-worktrees/feature",
      projectRoot: "F:/repo",
      worktreeBranch: "feature/x",
    },
    worktrees: [
      { path: "F:/repo", branch: "codex/fix-tui", isMain: true },
      { path: "F:/repo-worktrees/feature", branch: "feature/x", isMain: false },
    ],
    branches: ["codex/fix-tui", "feature/x", "main"],
  });
  assert.equal(state.worktreeLabel, "feature/x");
  assert.deepEqual(state.worktreeChoices, [
    { label: "codex/fix-tui", value: "F:/repo" },
    { label: "feature/x", value: "F:/repo-worktrees/feature" },
    { label: "main", value: "__branch__:main" },
  ]);
});

test("dock usage joins every fork usage chip and keeps MCP separate", () => {
  const state = buildSessionDisplayDockState({
    session: { id: "sess-3", cwd: "F:/repo" },
    context: {
      model: null,
      thinkingLevel: "auto",
      messages: [{ role: "assistant", usage: { input: 1200, output: 300 } }],
    },
    statuses: [
      { key: "pi-grok-usage", text: "SuperGrok 98%" },
      { key: "usage", text: "74%" },
      { key: "mcp", text: "MCP: 2 connected" },
    ],
  });
  assert.equal(state.usageLabel, "SuperGrok 98% · 74%");
  assert.equal(state.mcpLabel, "MCP: 2 connected");
});

test("dock usage falls back to context tokens when no usage chip exists", () => {
  const state = buildSessionDisplayDockState({
    session: { id: "sess-2", cwd: "F:/repo" },
    context: {
      model: null,
      thinkingLevel: "auto",
      messages: [{ role: "assistant", usage: { input: 1200, output: 300 } }],
    },
    statuses: [{ key: "mcp", text: "MCP" }],
  });
  assert.equal(state.usageLabel, "Context 1.5k");
});

test("dock actions use Pi commands and key input on the existing TermControl connection", () => {
  assert.equal(
    inputForSessionDisplayAction(
      { type: "action", sessionId: "sess-1", action: "model", value: "anthropic/sonnet" },
      { currentThinking: "medium", thinkingLevels: ["off", "medium", "high"] },
    ),
    "/model anthropic/sonnet\r\r",
  );
  assert.equal(
    inputForSessionDisplayAction(
      { type: "action", sessionId: "sess-1", action: "thinking", value: "off" },
      { currentThinking: "medium", thinkingLevels: ["off", "medium", "high"] },
    ),
    "\u001b[Z\u001b[Z",
  );
});
