import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TUI_RUNNING_REPORTER_NAME = "pi-desktop-tui-running-reporter.mjs";

const MARK = /\x1b\]9;pi-desktop-running;([01])(?:\x07|\x1b\\)/g;

export const TUI_RUNNING_REPORTER_SOURCE = `export default function (pi) {
  const sessionId = process.env.PI_DESKTOP_SESSION_ID;
  if (!sessionId) return;
  const write = (running) => {
    process.stdout.write("\\x1b]9;pi-desktop-running;" + (running ? "1" : "0") + "\\x07");
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

export function encodeTuiRunningMark(running: boolean): string {
  return `\x1b]9;pi-desktop-running;${running ? "1" : "0"}\x07`;
}

export function splitTuiRunningOutput(chunk: string): { text: string; running?: boolean } {
  let running: boolean | undefined;
  const text = chunk.replace(MARK, (_match, bit: string) => {
    running = bit === "1";
    return "";
  });
  return running === undefined ? { text } : { text, running };
}

export function writeTuiRunningReporter(directory = tmpdir()): string {
  const dest = join(directory, TUI_RUNNING_REPORTER_NAME);
  writeFileSync(dest, TUI_RUNNING_REPORTER_SOURCE);
  return dest;
}
