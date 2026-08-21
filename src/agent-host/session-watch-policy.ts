import path from "node:path";

export type SessionWatchChange = { kind: "ignore" } | { kind: "refresh-all" } | { kind: "refresh-path"; path: string };

export function sessionWatchTargets(
  agentDir: string,
  sessionsRoot: string,
): Array<{ directory: string; recursive: boolean }> {
  return [
    { directory: path.resolve(agentDir), recursive: false },
    { directory: path.resolve(sessionsRoot), recursive: false },
  ];
}

export function classifySessionWatchChange(
  agentDir: string,
  sessionsRoot: string,
  filename: string | Buffer | null,
  watchDirectory = agentDir,
): SessionWatchChange {
  if (!filename) return { kind: "refresh-all" };
  const name = filename.toString();
  const resolvedWatchDirectory = path.resolve(watchDirectory);
  const candidate = path.resolve(resolvedWatchDirectory, name);
  if (candidate !== resolvedWatchDirectory && !candidate.startsWith(`${resolvedWatchDirectory}${path.sep}`))
    return { kind: "ignore" };
  const resolvedSessionsRoot = path.resolve(sessionsRoot);
  if (resolvedWatchDirectory === path.resolve(agentDir) && candidate === resolvedSessionsRoot) {
    return { kind: "ignore" };
  }
  if (candidate.endsWith(".jsonl") && candidate.startsWith(`${resolvedSessionsRoot}${path.sep}`)) {
    return { kind: "refresh-path", path: candidate };
  }
  if (name.endsWith(".json") || name.includes("session")) return { kind: "refresh-all" };
  return { kind: "ignore" };
}
