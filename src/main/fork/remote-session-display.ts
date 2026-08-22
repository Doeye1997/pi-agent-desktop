import type {
  SessionDisplayAction,
  SessionDisplayDockState,
  SessionDisplayError,
  SessionDisplayMark,
  SessionDisplaySession,
  SessionDisplaySize,
  SessionDisplayStartResult,
  SessionDisplayTheme,
} from "../../shared/session-display.ts";
import type { SessionDisplayControlCommand, SessionDisplayControlEvent } from "../../shared/session-display-control.ts";

export function createRemoteSessionDisplayManager(options: {
  getParentWindowHandle: () => string | null;
  send: (command: SessionDisplayControlCommand) => void;
  onMark?: (sessionId: string, mark: SessionDisplayMark) => void;
  onAction?: (action: SessionDisplayAction) => void;
  onError?: (error: SessionDisplayError) => void;
  onDiagnostic?: (message: string) => void;
}) {
  let marks: Record<string, SessionDisplayMark> = {};

  function start(
    session: SessionDisplaySession,
    size?: SessionDisplaySize,
    remount = false,
  ): SessionDisplayStartResult {
    const parentWindowHandle = options.getParentWindowHandle();
    if (!parentWindowHandle) {
      const error: SessionDisplayError = {
        code: "INVALID_PARENT_WINDOW",
        sessionId: session.sessionId,
        message: "Cockpit native window handle is unavailable",
      };
      options.onError?.(error);
      return { action: "error", sessionId: session.sessionId };
    }
    options.send({ type: "start", session, parentWindowHandle, size, remount });
    return { action: marks[session.sessionId] ? "focus" : "spawn", sessionId: session.sessionId };
  }

  function handleHostEvent(event: SessionDisplayControlEvent): void {
    if (event.type === "marks") {
      const previous = marks;
      marks = { ...event.marks };
      const sessionIds = new Set([...Object.keys(previous), ...Object.keys(marks)]);
      for (const sessionId of sessionIds) {
        const mark = marks[sessionId];
        if (mark && mark !== previous[sessionId]) options.onMark?.(sessionId, mark);
      }
      return;
    }
    if (event.type === "error") options.onError?.(event.error);
    else if (event.type === "action") options.onAction?.(event.action);
    else options.onDiagnostic?.(event.message);
  }

  return {
    start,
    write: (sessionId: string, data: string) => options.send({ type: "write", sessionId, data }),
    resize: (sessionId: string, cols: number, rows: number) => options.send({ type: "resize", sessionId, cols, rows }),
    setBounds: (sessionId: string, bounds: import("../../shared/session-display.ts").SessionDisplayBounds) =>
      options.send({ type: "bounds", sessionId, bounds }),
    setTheme: (theme: SessionDisplayTheme) => options.send({ type: "theme", theme }),
    setDockState: (sessionId: string, state: SessionDisplayDockState) =>
      options.send({ type: "dock", sessionId, state }),
    hide: (sessionId: string) => options.send({ type: "hide", sessionId }),
    kill: (sessionId: string) => options.send({ type: "kill", sessionId }),
    dispose: () => options.send({ type: "detach" }),
    snapshotMarks: () => ({ ...marks }),
    handleHostEvent,
  };
}

export type RemoteSessionDisplayManager = ReturnType<typeof createRemoteSessionDisplayManager>;
