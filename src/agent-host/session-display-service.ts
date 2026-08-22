import type {
  SessionDisplayControlCommand,
  SessionDisplayControlEvent,
  SessionDisplayControlRequest,
  SessionDisplayControlResult,
} from "../shared/session-display-control.ts";
import type { SessionDisplayDockState, SessionDisplayHostEvent } from "../shared/session-display.ts";
import { createSessionDisplayManager } from "./fork/session-display.ts";
import type { SessionDisplayHost } from "./fork/windows-terminal-host.ts";
import type { SessionRuntimeState } from "../shared/runtime-registry.ts";
import {
  createTuiRunningReporterChannel,
  overlayDockUsage,
  readTuiUsageLabel,
  tuiRunningDir,
} from "./fork/tui-running-protocol.ts";

export function createSessionDisplayService(options: {
  emit: (event: SessionDisplayControlEvent) => void;
  onRunning: (sessionId: string, running: boolean) => void;
  createHost?: (onEvent: (event: SessionDisplayHostEvent) => void) => SessionDisplayHost;
  runningDirectory?: string;
  generation?: number;
  onStateChanged?: (states: Record<string, SessionRuntimeState>) => void;
}) {
  let parentWindowHandle: string | null = null;
  let generation = options.generation ?? 0;
  const runningDirectory = options.runningDirectory ?? tuiRunningDir();
  const tuiUsageLabels = new Map<string, string>();
  const lastDockState = new Map<string, SessionDisplayDockState>();
  const states = new Map<string, SessionRuntimeState>();
  const completedRequests = new Map<string, { generation: number; result: Promise<SessionDisplayControlResult> }>();
  const snapshotStates = (): Record<string, SessionRuntimeState> => Object.fromEntries(states);
  const setState = (sessionId: string, state: SessionRuntimeState): void => {
    if (states.get(sessionId) === state) return;
    states.set(sessionId, state);
    options.onStateChanged?.(snapshotStates());
  };
  const failedStartState = (priorState: SessionRuntimeState | undefined): SessionRuntimeState => {
    if (priorState === "running-attached" || priorState === "running-detached") return "orphaned";
    return "exited";
  };
  const tuiRunning = createTuiRunningReporterChannel({
    directory: runningDirectory,
    onRunning: options.onRunning,
    onUsage(sessionId, usageLabel) {
      if (usageLabel) tuiUsageLabels.set(sessionId, usageLabel);
      else tuiUsageLabels.delete(sessionId);
      const last = lastDockState.get(sessionId);
      if (last) manager.setDockState(sessionId, overlayDockUsage(last, tuiUsageLabels.get(sessionId)));
    },
  });
  const manager = createSessionDisplayManager({
    createHost: options.createHost,
    getParentWindowHandle: () => parentWindowHandle,
    onMark(sessionId, mark) {
      if (mark === "dead") {
        setState(sessionId, "exited");
        tuiRunning.clear(sessionId);
        tuiUsageLabels.delete(sessionId);
        options.onRunning(sessionId, false);
      }
      if (mark === "running") {
        setState(sessionId, parentWindowHandle ? "running-attached" : "running-detached");
      }
      emitMarks();
    },
    onError(error) {
      options.emit({ type: "error", error });
      emitMarks();
    },
    onAction(action) {
      options.emit({ type: "action", action });
    },
    onDiagnostic(message) {
      options.emit({ type: "diagnostic", message });
    },
  });

  function emitMarks(): void {
    options.emit({ type: "marks", marks: manager.snapshotMarks() });
  }

  function handle(command: SessionDisplayControlCommand): void | Promise<void> {
    switch (command.type) {
      case "start": {
        const priorState = states.get(command.session.sessionId);
        setState(command.session.sessionId, "starting");
        parentWindowHandle = command.parentWindowHandle;
        manager.attach();
        const started = manager.start(
          {
            ...command.session,
            program: tuiRunning.wrapProgram(command.session.program, command.session.sessionId),
          },
          command.size,
          command.remount,
        );
        const last = lastDockState.get(command.session.sessionId);
        if (started.action !== "error" && last) {
          manager.setDockState(
            command.session.sessionId,
            overlayDockUsage(last, tuiUsageLabels.get(command.session.sessionId)),
          );
        }
        setState(
          command.session.sessionId,
          started.action === "error" ? failedStartState(priorState) : "running-attached",
        );
        return;
      }
      case "write":
        manager.write(command.sessionId, command.data);
        return;
      case "resize":
        manager.resize(command.sessionId, command.cols, command.rows);
        return;
      case "bounds":
        manager.setBounds(command.sessionId, command.bounds);
        return;
      case "theme":
        manager.setTheme(command.theme);
        return;
      case "dock": {
        lastDockState.set(command.sessionId, command.state);
        manager.setDockState(
          command.sessionId,
          overlayDockUsage(
            command.state,
            tuiUsageLabels.get(command.sessionId) || readTuiUsageLabel(runningDirectory, command.sessionId),
          ),
        );
        return;
      }
      case "hide":
        manager.hide(command.sessionId);
        return;
      case "kill":
        setState(command.sessionId, "stopping");
        manager.kill(command.sessionId);
        setState(command.sessionId, "exited");
        return;
      case "detach":
        parentWindowHandle = null;
        return manager.detach().then(
          () => {
            for (const [sessionId, state] of states) {
              if (state === "running-attached" || state === "starting") {
                setState(sessionId, "running-detached");
              }
            }
          },
          (error) => {
            for (const [sessionId, state] of states) {
              if (state === "running-attached" || state === "starting") {
                setState(sessionId, "orphaned");
              }
            }
            throw error;
          },
        );
      case "sync":
        emitMarks();
    }
  }

  function dispose(): void {
    tuiRunning.dispose();
    manager.dispose();
  }

  function execute(request: SessionDisplayControlRequest): Promise<SessionDisplayControlResult> {
    if (generation === 0) generation = request.generation;
    if (request.generation !== generation) {
      return Promise.resolve({
        requestId: request.requestId,
        generation: request.generation,
        ok: false,
        message: `Session display request generation ${request.generation} does not match owner generation ${generation}`,
      });
    }
    const existing = completedRequests.get(request.requestId);
    if (existing) {
      if (existing.generation === request.generation) return existing.result;
      return Promise.resolve({
        requestId: request.requestId,
        generation: request.generation,
        ok: false,
        message: `Session display request ${request.requestId} was already used by generation ${existing.generation}`,
      });
    }
    const result = Promise.resolve()
      .then(() => handle(request.command))
      .then(
        (): SessionDisplayControlResult => ({
          requestId: request.requestId,
          generation: request.generation,
          ok: true,
        }),
        (error): SessionDisplayControlResult => ({
          requestId: request.requestId,
          generation: request.generation,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    completedRequests.set(request.requestId, { generation: request.generation, result });
    if (completedRequests.size > 512) {
      const oldestRequestId = completedRequests.keys().next().value;
      if (typeof oldestRequestId === "string") completedRequests.delete(oldestRequestId);
    }
    return result;
  }

  function hasLiveSessions(): boolean {
    return [...states.values()].some((state) => state !== "exited");
  }

  return {
    handle,
    execute,
    dispose,
    hasLiveSessions,
    snapshotStates,
    setGeneration(value: number) {
      generation = value;
    },
  };
}
