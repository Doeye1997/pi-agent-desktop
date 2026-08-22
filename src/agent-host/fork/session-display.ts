import type {
  SessionDisplayBounds,
  SessionDisplayAction,
  SessionDisplayDockState,
  SessionDisplayError,
  SessionDisplayHostEvent,
  SessionDisplayMark,
  SessionDisplaySession,
  SessionDisplaySize,
  SessionDisplayStartResult,
  SessionDisplayTheme,
} from "../../shared/session-display";
import {
  createWindowsTerminalHost,
  type SessionDisplayHost,
  type SessionDisplayHostMount,
} from "./windows-terminal-host.ts";

const DEFAULT_SIZE: SessionDisplaySize = { cols: 120, rows: 30 };

export type SessionDisplayManager = ReturnType<typeof createSessionDisplayManager>;

function validDimension(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const integer = Math.floor(value);
  return integer > 0 && integer <= 10_000 ? integer : null;
}

function validSize(size: SessionDisplaySize): SessionDisplaySize | null {
  const cols = validDimension(size.cols);
  const rows = validDimension(size.rows);
  return cols && rows ? { cols, rows } : null;
}

function toDisplayError(error: unknown, sessionId?: string): SessionDisplayError {
  const candidate = error as { code?: unknown; message?: unknown };
  const code =
    candidate?.code === "HOST_EXITED" ||
    candidate?.code === "HOST_PROTOCOL_ERROR" ||
    candidate?.code === "INVALID_PARENT_WINDOW"
      ? candidate.code
      : "HOST_UNAVAILABLE";
  return {
    code,
    ...(sessionId ? { sessionId } : {}),
    message: typeof candidate?.message === "string" ? candidate.message : String(error),
  };
}

export function createSessionDisplayManager(options: {
  createHost?: (onEvent: (event: SessionDisplayHostEvent) => void) => SessionDisplayHost;
  getParentWindowHandle: () => string | null;
  onMark?: (sessionId: string, mark: SessionDisplayMark) => void;
  onAction?: (action: SessionDisplayAction) => void;
  onError?: (error: SessionDisplayError) => void;
  onDiagnostic?: (message: string) => void;
}) {
  const sessions = new Map<string, SessionDisplaySession>();
  const marks = new Map<string, SessionDisplayMark>();
  const pendingBounds = new Map<string, SessionDisplayBounds>();
  const replacementDeadMarks = new Map<string, number>();
  let host: SessionDisplayHost | null = null;

  const consumeReplacementDeadMark = (sessionId: string): boolean => {
    const count = replacementDeadMarks.get(sessionId) ?? 0;
    if (count === 0) return false;
    if (count === 1) replacementDeadMarks.delete(sessionId);
    else replacementDeadMarks.set(sessionId, count - 1);
    return true;
  };

  const reportMark = (sessionId: string, mark: SessionDisplayMark): void => {
    marks.set(sessionId, mark);
    options.onMark?.(sessionId, mark);
  };

  const reportError = (error: SessionDisplayError): void => {
    if (error.sessionId) reportMark(error.sessionId, "dead");
    options.onError?.(error);
  };

  const onHostEvent = (event: SessionDisplayHostEvent): void => {
    if (event.type === "action") {
      if (sessions.has(event.sessionId)) options.onAction?.(event);
      return;
    }
    if (event.type === "mark") {
      if (event.mark === "dead" && consumeReplacementDeadMark(event.sessionId)) return;
      reportMark(event.sessionId, event.mark);
      if (event.mark === "dead" && sessions.has(event.sessionId)) {
        try {
          host?.dead(event.sessionId);
        } catch (error) {
          reportError(toDisplayError(error, event.sessionId));
        }
      }
      return;
    }
    if (event.type === "error") {
      if (event.code === "INVALID_PARENT_WINDOW") {
        options.onError?.(event);
        return;
      }
      reportError(event);
      if (event.sessionId) sessions.delete(event.sessionId);
      return;
    }
    const error = { code: event.code, message: event.message } satisfies SessionDisplayError;
    if (event.code === "INVALID_PARENT_WINDOW") {
      options.onError?.(error);
      return;
    }
    const sessionIds = [...sessions.keys()];
    if (sessionIds.length === 0) reportError(error);
    for (const sessionId of sessionIds) {
      reportMark(sessionId, "dead");
      reportError({ ...error, sessionId });
    }
    sessions.clear();
    replacementDeadMarks.clear();
    host = null;
  };

  const ensureHost = (): SessionDisplayHost => {
    if (host) return host;
    host =
      options.createHost?.(onHostEvent) ??
      createWindowsTerminalHost({ onEvent: onHostEvent, onDiagnostic: options.onDiagnostic });
    return host;
  };

  const failStart = (sessionId: string, error: unknown): SessionDisplayStartResult => {
    const displayError = toDisplayError(error, sessionId);
    reportError(displayError);
    return { action: "error", sessionId };
  };

  function attach(): void {
    if (sessions.size === 0) return;
    const parentWindowHandle = options.getParentWindowHandle();
    if (!parentWindowHandle) return;
    try {
      ensureHost().attach(parentWindowHandle);
    } catch (error) {
      reportError(toDisplayError(error));
    }
  }

  async function detach(): Promise<void> {
    if (!host || sessions.size === 0) return;
    try {
      await host.detach();
    } catch (error) {
      reportError(toDisplayError(error));
      throw error;
    }
  }

  function start(
    request: SessionDisplaySession,
    requestedSize: SessionDisplaySize = DEFAULT_SIZE,
    remount = false,
  ): SessionDisplayStartResult {
    const size = validSize(requestedSize) ?? DEFAULT_SIZE;
    const existing = sessions.get(request.sessionId);
    if (existing && !remount) {
      try {
        ensureHost().focus(request.sessionId);
        sessions.set(request.sessionId, request);
        return { action: "focus", sessionId: request.sessionId };
      } catch (error) {
        sessions.delete(request.sessionId);
        return failStart(request.sessionId, error);
      }
    }
    if (existing) {
      replacementDeadMarks.set(request.sessionId, (replacementDeadMarks.get(request.sessionId) ?? 0) + 1);
      try {
        host?.kill(request.sessionId);
      } catch {
        consumeReplacementDeadMark(request.sessionId);
        // The replacement mount still gets a chance to report a useful host error.
      }
      sessions.delete(request.sessionId);
      reportMark(request.sessionId, "dead");
    }

    const parentWindowHandle = options.getParentWindowHandle();
    if (!parentWindowHandle) {
      return failStart(request.sessionId, {
        code: "INVALID_PARENT_WINDOW",
        message: "Cockpit native window handle is unavailable",
      });
    }

    const mount: SessionDisplayHostMount = { session: request, size, parentWindowHandle };
    try {
      ensureHost().mount(mount);
      sessions.set(request.sessionId, request);
      reportMark(request.sessionId, "running");
      const bounds = pendingBounds.get(request.sessionId);
      if (bounds) setBounds(request.sessionId, bounds);
      return { action: "spawn", sessionId: request.sessionId };
    } catch (error) {
      return failStart(request.sessionId, error);
    }
  }

  function write(sessionId: string, data: string): void {
    if (!data || data.length > 1_048_576 || !sessions.has(sessionId)) return;
    try {
      host?.write(sessionId, data);
    } catch (error) {
      reportError(toDisplayError(error, sessionId));
    }
  }

  function resize(sessionId: string, cols: number, rows: number): void {
    const size = validSize({ cols, rows });
    if (!size || !sessions.has(sessionId)) return;
    try {
      host?.resize(sessionId, size);
    } catch (error) {
      reportError(toDisplayError(error, sessionId));
    }
  }

  function setBounds(sessionId: string, bounds: SessionDisplayBounds): void {
    if (
      !Number.isFinite(bounds.x) ||
      !Number.isFinite(bounds.y) ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height) ||
      !Number.isFinite(bounds.scaleFactor) ||
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      bounds.scaleFactor <= 0
    ) {
      return;
    }
    pendingBounds.set(sessionId, bounds);
    if (!sessions.has(sessionId)) return;
    try {
      host?.setBounds(sessionId, bounds);
    } catch (error) {
      reportError(toDisplayError(error, sessionId));
    }
  }

  function setTheme(theme: SessionDisplayTheme): void {
    try {
      host?.setTheme(theme);
    } catch (error) {
      reportError(toDisplayError(error));
    }
  }

  function setDockState(sessionId: string, state: SessionDisplayDockState): void {
    if (!sessions.has(sessionId)) return;
    try {
      host?.setDockState(sessionId, state);
    } catch (error) {
      reportError(toDisplayError(error, sessionId));
    }
  }

  function hide(sessionId: string): void {
    if (!sessions.has(sessionId)) return;
    try {
      host?.hide(sessionId);
    } catch (error) {
      reportError(toDisplayError(error, sessionId));
    }
  }

  function kill(sessionId: string): void {
    sessions.delete(sessionId);
    pendingBounds.delete(sessionId);
    reportMark(sessionId, "dead");
    try {
      host?.kill(sessionId);
    } catch (error) {
      reportError(toDisplayError(error, sessionId));
    }
  }

  function dispose(): void {
    const liveSessionIds = [...sessions.keys()];
    sessions.clear();
    pendingBounds.clear();
    replacementDeadMarks.clear();
    for (const sessionId of liveSessionIds) marks.set(sessionId, "dead");
    try {
      host?.dispose();
    } finally {
      host = null;
      marks.clear();
    }
  }

  function snapshotMarks(): Record<string, SessionDisplayMark> {
    return Object.fromEntries(marks);
  }

  return {
    attach,
    detach,
    start,
    write,
    resize,
    setBounds,
    setTheme,
    setDockState,
    hide,
    kill,
    dispose,
    snapshotMarks,
  };
}
