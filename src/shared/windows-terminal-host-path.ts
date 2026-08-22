import { existsSync } from "node:fs";
import { basename, join } from "node:path";

export const WINDOWS_TERMINAL_HOST_FILENAME = "pi-session-display-host.exe";

export function resolveWindowsTerminalHostPath(
  env = process.env,
  resourcesPath = typeof process.resourcesPath === "string" ? process.resourcesPath : "",
  cwd = process.cwd(),
): string | null {
  if (process.platform !== "win32") return null;
  const configured = env.PI_DESKTOP_WINDOWS_TERMINAL_HOST?.trim();
  const candidates = [
    configured,
    resourcesPath ? join(resourcesPath, "wt-xaml-island", WINDOWS_TERMINAL_HOST_FILENAME) : undefined,
    join(cwd, "build", "toolchains", "windows-terminal", "win-x64", WINDOWS_TERMINAL_HOST_FILENAME),
    join(cwd, "native", "wt-xaml-island", WINDOWS_TERMINAL_HOST_FILENAME),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return (
    candidates.find((candidate) => basename(candidate).toLowerCase() !== "wt.exe" && existsSync(candidate)) ?? null
  );
}
