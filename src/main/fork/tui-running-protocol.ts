import { mkdirSync, readFileSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TUI_RUNNING_REPORTER_NAME = "pi-desktop-tui-running-reporter.mjs";

export const TUI_RUNNING_REPORTER_SOURCE = `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default function (pi) {
  const sessionId = process.env.PI_DESKTOP_SESSION_ID;
  const dir = process.env.PI_DESKTOP_RUNNING_DIR;
  if (!sessionId || !dir) return;
  const write = (running) => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, encodeURIComponent(sessionId)), running ? "1" : "0");
    } catch {
      // Sidebar running is best-effort; never break the TUI.
    }
  };
  pi.on("session_start", (_event, ctx) => {
    if (ctx?.mode !== "tui") return;
    if (ctx?.isIdle?.() === false) write(true);
  });
  pi.on("agent_start", () => write(true));
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx?.isIdle?.() === true) write(false);
  });
}
`;

export function tuiRunningDir(root = tmpdir()): string {
  return join(root, "pi-desktop-tui-running");
}

export function tuiRunningMarkPath(directory: string, sessionId: string): string {
  return join(directory, encodeURIComponent(sessionId));
}

export function writeTuiRunningReporter(directory = tmpdir()): string {
  mkdirSync(directory, { recursive: true });
  const dest = join(directory, TUI_RUNNING_REPORTER_NAME);
  writeFileSync(dest, TUI_RUNNING_REPORTER_SOURCE);
  return dest;
}

export function writeTuiRunningLauncher(options: {
  directory: string;
  cliPath: string;
  reporterPath: string;
  runningDir: string;
  sessionId: string;
}): string {
  mkdirSync(options.directory, { recursive: true });
  const dest = join(options.directory, `tui-launcher-${encodeURIComponent(options.sessionId)}.mjs`);
  writeFileSync(
    dest,
    `import { pathToFileURL } from "node:url";
process.env.PI_DESKTOP_SESSION_ID = ${JSON.stringify(options.sessionId)};
process.env.PI_DESKTOP_RUNNING_DIR = ${JSON.stringify(options.runningDir)};
process.argv = [process.execPath, ${JSON.stringify(options.cliPath)}, "--extension", ${JSON.stringify(options.reporterPath)}, ...process.argv.slice(2)];
await import(pathToFileURL(${JSON.stringify(options.cliPath)}).href);
`,
  );
  return dest;
}

export function readTuiRunningMark(directory: string, sessionId: string): boolean | undefined {
  try {
    const text = readFileSync(tuiRunningMarkPath(directory, sessionId), "utf8").trim();
    if (text === "1") return true;
    if (text === "0") return false;
    return undefined;
  } catch {
    return false;
  }
}

export function clearTuiRunningMark(directory: string, sessionId: string): void {
  try {
    unlinkSync(tuiRunningMarkPath(directory, sessionId));
  } catch {
    // already gone
  }
}

export function watchTuiRunningMarks(
  directory: string,
  onRunning: (sessionId: string, running: boolean) => void,
): () => void {
  mkdirSync(directory, { recursive: true });
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(directory, { persistent: false }, (_event, filename) => {
      const name = typeof filename === "string" ? filename : filename?.toString();
      if (!name || name === TUI_RUNNING_REPORTER_NAME || name.startsWith("tui-launcher-")) return;
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(name);
      } catch {
        return;
      }
      const running = readTuiRunningMark(directory, sessionId);
      if (running === undefined) return;
      onRunning(sessionId, running);
    });
  } catch {
    return () => undefined;
  }
  return () => {
    watcher?.close();
  };
}

export function createTuiRunningReporterChannel(options: {
  directory?: string;
  onRunning: (sessionId: string, running: boolean) => void;
}): {
  wrapProgram: (cliPath: string, sessionId: string) => string;
  clear: (sessionId: string) => void;
  dispose: () => void;
} {
  const directory = options.directory ?? tuiRunningDir();
  mkdirSync(directory, { recursive: true });
  const reporterPath = writeTuiRunningReporter(directory);
  const dispose = watchTuiRunningMarks(directory, options.onRunning);
  return {
    wrapProgram(cliPath: string, sessionId: string): string {
      return writeTuiRunningLauncher({
        directory,
        cliPath,
        reporterPath,
        runningDir: directory,
        sessionId,
      });
    },
    clear(sessionId: string): void {
      clearTuiRunningMark(directory, sessionId);
    },
    dispose,
  };
}
