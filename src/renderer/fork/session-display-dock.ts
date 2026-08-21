import type {
  SessionDisplayAction,
  SessionDisplayChoice,
  SessionDisplayDockState,
} from "../../shared/session-display";
import { forkUsageChips } from "./usage.ts";

type DockSession = {
  id: string;
  cwd: string;
  path?: string;
  projectRoot?: string;
  worktreeBranch?: string;
};

type DockModel = { id: string; name: string; provider: string };

type DockContext = {
  model: { provider: string; modelId: string } | null;
  thinkingLevel: string;
  messages: Array<{
    role?: string;
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  }>;
};

export type SessionDisplayDockSources = {
  session: DockSession;
  sessions?: Array<Pick<DockSession, "id" | "cwd">>;
  worktrees?: Array<{ path: string; branch?: string | null; isMain?: boolean }>;
  models?: { models: DockModel[]; thinkingLevels?: Record<string, string[]> };
  context?: DockContext;
  skills?: Array<{ name: string; description?: string }>;
  statuses?: Array<{ key: string; text: string }>;
};

function pathLabel(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).at(-1) || path;
}

function uniquePathChoices(paths: string[]): SessionDisplayChoice[] {
  const seen = new Set<string>();
  const choices: SessionDisplayChoice[] = [];
  for (const path of paths) {
    const value = path.trim();
    const key = value.replaceAll("\\", "/").toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    choices.push({ label: pathLabel(value), value });
  }
  return choices;
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${Number((tokens / 1_000).toFixed(1))}k`;
  return `${Number((tokens / 1_000_000).toFixed(1))}m`;
}

function contextUsageLabel(
  context?: DockContext,
  statuses?: Array<{ key: string; text: string }>,
): string {
  const chips = forkUsageChips(statuses ?? []);
  if (chips.length > 0) return chips.map((chip) => chip.text.trim()).join(" · ");
  const message = context?.messages.findLast((candidate) => candidate.role === "assistant" && candidate.usage);
  if (!message?.usage) return "Usage —";
  const tokens =
    (message.usage.input ?? 0) +
    (message.usage.output ?? 0) +
    (message.usage.cacheRead ?? 0) +
    (message.usage.cacheWrite ?? 0);
  return `Context ${formatTokens(tokens)}`;
}

function titleCase(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : "Auto";
}

export function buildSessionDisplayDockState(sources: SessionDisplayDockSources): SessionDisplayDockState {
  const currentModel = sources.context?.model;
  const currentModelInfo = currentModel
    ? sources.models?.models.find(
        (model) => model.provider === currentModel.provider && model.id === currentModel.modelId,
      )
    : undefined;
  const modelKey = currentModel ? `${currentModel.provider}:${currentModel.modelId}` : "";
  const thinkingLevels = modelKey ? (sources.models?.thinkingLevels?.[modelKey] ?? []) : [];
  const mcpStatus = sources.statuses?.find((status) => status.key.toLowerCase() === "mcp");

  return {
    cwdLabel: pathLabel(sources.session.cwd),
    worktreeLabel: sources.session.worktreeBranch || "Worktree",
    usageLabel: contextUsageLabel(sources.context, sources.statuses),
    modelLabel: currentModelInfo?.name || currentModel?.modelId || "Model",
    thinkingLabel: titleCase(sources.context?.thinkingLevel || "auto"),
    mcpLabel: mcpStatus?.text.trim() || "MCP",
    cwdChoices: uniquePathChoices([
      sources.session.cwd,
      ...(sources.sessions?.map((session) => session.cwd) ?? []),
    ]),
    worktreeChoices: (sources.worktrees ?? []).map((worktree) => ({
      label: worktree.branch || (worktree.isMain ? "main" : pathLabel(worktree.path)),
      value: worktree.path,
    })),
    modelChoices: (sources.models?.models ?? []).map((model) => ({
      label: model.name || model.id,
      value: `${model.provider}/${model.id}`,
    })),
    thinkingChoices: thinkingLevels.map((level) => ({ label: titleCase(level), value: level })),
    skillChoices: (sources.skills ?? []).map((skill) => ({
      label: skill.description ? `/${skill.name} — ${skill.description}` : `/${skill.name}`,
      value: `/${skill.name}`,
    })),
  };
}

export function inputForSessionDisplayAction(
  action: SessionDisplayAction,
  state: { currentThinking: string; thinkingLevels: string[] },
): string | null {
  if (action.action === "model" && action.value) return `/model ${action.value}\r\r`;
  if (action.action !== "thinking" || !action.value || state.thinkingLevels.length === 0) return null;
  const currentIndex = state.thinkingLevels.indexOf(state.currentThinking);
  const targetIndex = state.thinkingLevels.indexOf(action.value);
  if (currentIndex < 0 || targetIndex < 0) return null;
  const cycles = (targetIndex - currentIndex + state.thinkingLevels.length) % state.thinkingLevels.length;
  return "\u001b[Z".repeat(cycles);
}
