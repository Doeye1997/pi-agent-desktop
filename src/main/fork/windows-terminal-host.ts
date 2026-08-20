import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import type {
  SessionDisplayBounds,
  SessionDisplayHostEvent,
  SessionDisplaySession,
  SessionDisplaySize,
  SessionDisplayTheme,
} from "../../shared/session-display";

export const WINDOWS_TERMINAL_HOST_FILENAME = "pi-session-display-host.exe";

export type SessionDisplayHostMount = {
  session: SessionDisplaySession;
  size: SessionDisplaySize;
  parentWindowHandle: string;
};

export type SessionDisplayHost = {
  mount: (request: SessionDisplayHostMount) => void;
  focus: (sessionId: string) => void;
  write: (sessionId: string, data: string) => void;
  resize: (sessionId: string, size: SessionDisplaySize) => void;
  setBounds: (sessionId: string, bounds: SessionDisplayBounds) => void;
  setTheme: (theme: SessionDisplayTheme) => void;
  kill: (sessionId: string) => void;
  dispose: () => void;
};

type HostCommand =
  | { type: "mount"; request: SessionDisplayHostMount }
  | { type: "focus"; sessionId: string }
  | { type: "write"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; size: SessionDisplaySize }
  | { type: "bounds"; sessionId: string; bounds: SessionDisplayBounds }
  | { type: "theme"; theme: SessionDisplayTheme }
  | { type: "kill"; sessionId: string }
  | { type: "dispose" };

type SpawnProcess = (file: string, args: string[], options: SpawnOptions) => ChildProcess;

function isErrorCode(
  value: unknown,
): value is "HOST_UNAVAILABLE" | "HOST_EXITED" | "HOST_PROTOCOL_ERROR" | "INVALID_PARENT_WINDOW" {
  return (
    value === "HOST_UNAVAILABLE" ||
    value === "HOST_EXITED" ||
    value === "HOST_PROTOCOL_ERROR" ||
    value === "INVALID_PARENT_WINDOW"
  );
}

function parseHostEvent(line: string): SessionDisplayHostEvent {
  const value = JSON.parse(line) as Record<string, unknown>;
  if (
    value.type === "mark" &&
    typeof value.sessionId === "string" &&
    (value.mark === "running" || value.mark === "dead")
  ) {
    return { type: "mark", sessionId: value.sessionId, mark: value.mark };
  }
  if (
    value.type === "error" &&
    (value.sessionId === undefined || typeof value.sessionId === "string") &&
    isErrorCode(value.code) &&
    typeof value.message === "string"
  ) {
    return {
      type: "error",
      ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
      code: value.code,
      message: value.message,
    };
  }
  if (value.type === "host-error" && isErrorCode(value.code) && typeof value.message === "string") {
    return { type: "host-error", code: value.code, message: value.message };
  }
  throw new Error("event shape");
}

export function resolveWindowsTerminalHostPath(
  env = process.env,
  resourcesPath = process.resourcesPath,
  cwd = process.cwd(),
): string | null {
  if (process.platform !== "win32") return null;
  const configured = env.PI_DESKTOP_WINDOWS_TERMINAL_HOST?.trim();
  const candidates = [
    configured,
    join(resourcesPath, "wt-xaml-island", WINDOWS_TERMINAL_HOST_FILENAME),
    join(cwd, "build", "toolchains", "windows-terminal", "win-x64", WINDOWS_TERMINAL_HOST_FILENAME),
    join(cwd, "native", "wt-xaml-island", WINDOWS_TERMINAL_HOST_FILENAME),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return (
    candidates.find((candidate) => basename(candidate).toLowerCase() !== "wt.exe" && existsSync(candidate)) ?? null
  );
}

function hostError(message: string, code: "HOST_UNAVAILABLE" | "HOST_EXITED" | "HOST_PROTOCOL_ERROR") {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function sendCommand(child: ChildProcessWithoutNullStreams, command: HostCommand): void {
  if (!child.stdin.writable) throw hostError("Windows Terminal XAML host is not writable", "HOST_EXITED");
  child.stdin.write(`${JSON.stringify(command)}\n`);
}

export function createWindowsTerminalHost(options: {
  executable?: string | null;
  spawnProcess?: SpawnProcess;
  onEvent: (event: SessionDisplayHostEvent) => void;
  onDiagnostic?: (message: string) => void;
}): SessionDisplayHost {
  if (process.platform !== "win32") {
    throw hostError("Windows Terminal XAML host is supported only on Windows", "HOST_UNAVAILABLE");
  }
  const executable = options.executable ?? resolveWindowsTerminalHostPath();
  if (!executable || basename(executable).toLowerCase() === "wt.exe") {
    throw hostError(
      `Windows Terminal XAML host is unavailable. Expected ${WINDOWS_TERMINAL_HOST_FILENAME}.`,
      "HOST_UNAVAILABLE",
    );
  }

  const spawnProcess = options.spawnProcess ?? spawn;
  let disposed = false;
  let child: ChildProcessWithoutNullStreams;
  try {
    const spawned = spawnProcess(executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    if (!spawned.stdin || !spawned.stdout || !spawned.stderr) {
      spawned.kill();
      throw hostError("Windows Terminal XAML host did not expose pipe streams", "HOST_UNAVAILABLE");
    }
    child = spawned as ChildProcessWithoutNullStreams;
  } catch (error) {
    throw hostError(
      `Windows Terminal XAML host failed to start: ${error instanceof Error ? error.message : String(error)}`,
      "HOST_UNAVAILABLE",
    );
  }

  const reportHostError = (code: "HOST_EXITED" | "HOST_PROTOCOL_ERROR", message: string) => {
    if (disposed) return;
    options.onEvent({ type: "host-error", code, message });
  };
  const output = createInterface({ input: child.stdout });
  const diagnostics = createInterface({ input: child.stderr });
  output.on("line", (line) => {
    try {
      options.onEvent(parseHostEvent(line));
    } catch {
      reportHostError("HOST_PROTOCOL_ERROR", "Windows Terminal XAML host returned invalid event data");
    }
  });
  diagnostics.on("line", (line) => options.onDiagnostic?.(line));
  child.once("error", (error) => {
    reportHostError("HOST_EXITED", `Windows Terminal XAML host failed: ${error.message}`);
  });
  child.once("exit", (code) => {
    if (disposed) return;
    reportHostError("HOST_EXITED", `Windows Terminal XAML host exited with code ${code ?? "unknown"}`);
  });

  return {
    mount: (request) => sendCommand(child, { type: "mount", request }),
    focus: (sessionId) => sendCommand(child, { type: "focus", sessionId }),
    write: (sessionId, data) => sendCommand(child, { type: "write", sessionId, data }),
    resize: (sessionId, size) => sendCommand(child, { type: "resize", sessionId, size }),
    setBounds: (sessionId, bounds) => sendCommand(child, { type: "bounds", sessionId, bounds }),
    setTheme: (theme) => sendCommand(child, { type: "theme", theme }),
    kill: (sessionId) => sendCommand(child, { type: "kill", sessionId }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      output.close();
      diagnostics.close();
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ type: "dispose" })}\n`);
      child.kill();
    },
  };
}
