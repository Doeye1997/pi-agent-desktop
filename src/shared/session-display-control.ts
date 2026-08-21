import type {
  SessionDisplayBounds,
  SessionDisplayDockState,
  SessionDisplayError,
  SessionDisplayMark,
  SessionDisplaySession,
  SessionDisplaySize,
  SessionDisplayTheme,
} from "./session-display.ts";

export type SessionDisplayControlCommand =
  | {
      type: "start";
      session: SessionDisplaySession;
      parentWindowHandle: string;
      size?: SessionDisplaySize;
      remount?: boolean;
    }
  | { type: "write"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | { type: "bounds"; sessionId: string; bounds: SessionDisplayBounds }
  | { type: "theme"; theme: SessionDisplayTheme }
  | { type: "dock"; sessionId: string; state: SessionDisplayDockState }
  | { type: "hide"; sessionId: string }
  | { type: "kill"; sessionId: string }
  | { type: "detach" }
  | { type: "sync" };

export type SessionDisplayControlEvent =
  | { type: "marks"; marks: Record<string, SessionDisplayMark> }
  | { type: "error"; error: SessionDisplayError }
  | { type: "action"; action: import("./session-display.ts").SessionDisplayAction }
  | { type: "diagnostic"; message: string };

export interface SessionDisplayControlRequest {
  requestId: string;
  generation: number;
  command: SessionDisplayControlCommand;
}

export type SessionDisplayControlResult =
  | {
      requestId: string;
      generation: number;
      ok: true;
    }
  | {
      requestId: string;
      generation: number;
      ok: false;
      message: string;
    };
