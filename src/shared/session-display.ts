export type SessionDisplayMark = "running" | "dead";

export type SessionDisplayTheme = "light" | "dark";

export type SessionDisplayChoice = {
  label: string;
  value: string;
};

export type SessionDisplayDockState = {
  cwdLabel: string;
  worktreeLabel: string;
  usageLabel: string;
  modelLabel: string;
  thinkingLabel: string;
  mcpLabel: string;
  cwdChoices: SessionDisplayChoice[];
  worktreeChoices: SessionDisplayChoice[];
  modelChoices: SessionDisplayChoice[];
  thinkingChoices: SessionDisplayChoice[];
  skillChoices: SessionDisplayChoice[];
};

export type SessionDisplayActionName = "relocate" | "browse-cwd" | "model" | "thinking";

export type SessionDisplayAction = {
  type: "action";
  sessionId: string;
  action: SessionDisplayActionName;
  value?: string;
};

export type SessionDisplaySize = {
  cols: number;
  rows: number;
};

export type SessionDisplayBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
};

export type SessionDisplaySession = {
  sessionId: string;
  sessionPath?: string;
  cwd: string;
  nodeExecutable: string;
  program: string;
};

export type SessionDisplayErrorCode =
  "HOST_UNAVAILABLE" | "HOST_EXITED" | "HOST_PROTOCOL_ERROR" | "INVALID_PARENT_WINDOW";

export type SessionDisplayError = {
  code: SessionDisplayErrorCode;
  sessionId?: string;
  message: string;
};

export type SessionDisplayHostEvent =
  | { type: "mark"; sessionId: string; mark: SessionDisplayMark }
  | SessionDisplayAction
  | {
      type: "error";
      sessionId?: string;
      code: SessionDisplayErrorCode;
      message: string;
    }
  | { type: "host-error"; code: SessionDisplayErrorCode; message: string };
