import { useEffect, useRef, useState } from "react";
import type { SessionDisplayBounds, SessionDisplayError } from "@shared/session-display";
import type { SessionInfo } from "@shared/types";
import { call, getSession, listModels, listSessions, listWorktrees, relocateSession } from "@/lib/api-client";
import {
  WORKTREE_BRANCH_PICK_PREFIX,
  buildSessionDisplayDockState,
  inputForSessionDisplayAction,
  type SessionDisplayDockSources,
} from "@/fork/session-display-dock";

function readDisplayBounds(element: HTMLElement): SessionDisplayBounds | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    scaleFactor: window.devicePixelRatio || 1,
  };
}

function displayErrorTitle(error: SessionDisplayError): string {
  if (error.code === "INVALID_PARENT_WINDOW") return "Windows Terminal XAML host cannot attach to cockpit";
  if (error.code === "HOST_EXITED") return "Windows Terminal XAML host exited";
  if (error.code === "HOST_PROTOCOL_ERROR") return "Windows Terminal XAML host protocol failed";
  return "Windows Terminal XAML host unavailable";
}

export function EmbeddedPiTerminal({
  session,
  theme,
  onRelocated,
}: {
  session: SessionInfo | null;
  theme: "light" | "dark";
  onRelocated?: (session: SessionInfo) => void;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const selectedSessionId = useRef<string | null>(session?.id ?? null);
  const dockActionState = useRef({ currentThinking: "auto", thinkingLevels: [] as string[] });
  const lastWorktreesRef = useRef<{
    projectKey: string;
    worktrees: NonNullable<SessionDisplayDockSources["worktrees"]>;
    branches: string[];
  } | null>(null);
  const [displayError, setDisplayError] = useState<SessionDisplayError | null>(null);

  useEffect(() => {
    selectedSessionId.current = session?.id ?? null;
    setDisplayError(null);
  }, [session?.id]);

  useEffect(() => {
    return window.piBridge.onSessionDisplayError((error) => {
      if (!error.sessionId || error.sessionId === selectedSessionId.current) setDisplayError(error);
    });
  }, []);

  useEffect(() => {
    return window.piBridge.onSessionDisplayAction((action) => {
      if (action.sessionId !== selectedSessionId.current) return;
      const relocate = async (cwd: string) => {
        try {
          const result = await relocateSession(action.sessionId, cwd);
          onRelocated?.(result.session);
        } catch (error) {
          setDisplayError({
            code: "HOST_PROTOCOL_ERROR",
            sessionId: action.sessionId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      };
      if (action.action === "browse-cwd") {
        void window.piBridge.selectDirectory().then((cwd) => {
          if (cwd) return relocate(cwd);
        });
        return;
      }
      if (action.action === "relocate" && action.value) {
        if (action.value.startsWith(WORKTREE_BRANCH_PICK_PREFIX)) {
          const branch = action.value.slice(WORKTREE_BRANCH_PICK_PREFIX.length);
          const projectRoot = session?.projectRoot ?? session?.cwd;
          if (!branch || !projectRoot) return;
          void call("worktrees.create", { projectRoot, cwd: projectRoot, branch })
            .then((result) => relocate(result.worktree.path))
            .catch((error) => {
              setDisplayError({
                code: "HOST_PROTOCOL_ERROR",
                sessionId: action.sessionId,
                message: error instanceof Error ? error.message : String(error),
              });
            });
          return;
        }
        void relocate(action.value);
        return;
      }
      const input = inputForSessionDisplayAction(action, dockActionState.current);
      if (input) window.piBridge.writeSessionDisplay(action.sessionId, input);
    });
  }, [onRelocated, session]);

  useEffect(() => {
    window.piBridge.setSessionDisplayTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!session) return;
    let active = true;
    let live = false;
    let contextTimer: number | undefined;
    const sources: SessionDisplayDockSources = { session };
    const projectKey = session.projectRoot ?? session.cwd;
    const cached = lastWorktreesRef.current;
    if (cached && cached.projectKey === projectKey) {
      sources.worktrees = cached.worktrees;
      sources.branches = cached.branches;
    }
    let worktreesReady = Boolean(sources.worktrees);
    const publish = () => {
      if (!active || selectedSessionId.current !== session.id || !worktreesReady) return;
      const state = buildSessionDisplayDockState(sources);
      const currentModel = sources.context?.model;
      const modelKey = currentModel ? `${currentModel.provider}:${currentModel.modelId}` : "";
      dockActionState.current = {
        currentThinking: sources.context?.thinkingLevel || "auto",
        thinkingLevels: modelKey ? (sources.models?.thinkingLevels?.[modelKey] ?? []) : [],
      };
      window.piBridge.setSessionDisplayDockState(session.id, state);
    };
    const refreshContext = () => {
      void getSession(session.id, true, undefined, { maxTurns: 8, maxBytes: 256 * 1024 })
        .then((result) => {
          if (!active) return;
          sources.context = result.context;
          sources.statuses = result.agentState?.state?.extensionStatuses;
          publish();
        })
        .catch(() => undefined);
    };
    const startLiveUpdates = () => {
      if (!active || live) return;
      live = true;
      void listSessions()
        .then((result) => {
          if (!active) return;
          sources.sessions = result.sessions;
          publish();
        })
        .catch(() => undefined);
      void listModels(session.cwd)
        .then((result) => {
          if (!active) return;
          sources.models = result;
          publish();
        })
        .catch(() => undefined);
      void call("skills.list", { cwd: session.cwd })
        .then((result) => {
          if (!active) return;
          sources.skills = result.skills;
          publish();
        })
        .catch(() => undefined);
      refreshContext();
      contextTimer = window.setInterval(refreshContext, 2_000);
    };
    if (sources.worktrees) {
      publish();
      startLiveUpdates();
    }
    void listWorktrees(projectKey)
      .then((result) => {
        if (!active) return;
        sources.worktrees = result.worktrees;
        sources.branches = result.branches;
        lastWorktreesRef.current = {
          projectKey,
          worktrees: result.worktrees,
          branches: result.branches,
        };
      })
      .catch(() => undefined)
      .then(() => {
        if (!active) return;
        worktreesReady = true;
        publish();
        startLiveUpdates();
      });
    return () => {
      active = false;
      if (contextTimer) window.clearInterval(contextTimer);
    };
  }, [session]);

  useEffect(() => {
    const element = root.current;
    const sessionId = session?.id;
    if (!element || !sessionId) return;

    let lastBounds = "";
    const publishBounds = () => {
      const bounds = readDisplayBounds(element);
      if (!bounds || selectedSessionId.current !== sessionId) return;
      const key = `${bounds.x}|${bounds.y}|${bounds.width}|${bounds.height}|${bounds.scaleFactor}`;
      if (key === lastBounds) return;
      lastBounds = key;
      window.piBridge.setSessionDisplayBounds(sessionId, bounds);
    };
    const observer = new ResizeObserver(publishBounds);
    observer.observe(element);
    publishBounds();
    window.addEventListener("resize", publishBounds);
    window.addEventListener("scroll", publishBounds, true);
    window.visualViewport?.addEventListener("resize", publishBounds);
    window.visualViewport?.addEventListener("scroll", publishBounds);
    document.addEventListener("visibilitychange", publishBounds);
    const alignmentTimer = window.setInterval(publishBounds, 500);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publishBounds);
      window.removeEventListener("scroll", publishBounds, true);
      window.visualViewport?.removeEventListener("resize", publishBounds);
      window.visualViewport?.removeEventListener("scroll", publishBounds);
      document.removeEventListener("visibilitychange", publishBounds);
      window.clearInterval(alignmentTimer);
      window.piBridge.hideSessionDisplay(sessionId);
    };
  }, [session?.id]);

  return (
    <div
      ref={root}
      className="embedded-pi-terminal"
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        background: "var(--bg)",
      }}
    >
      {session ? (
        <div
          data-session-display-hole
          aria-label={`Pi Windows Terminal display ${session.id}`}
          style={{ position: "absolute", inset: 0, background: "var(--bg)" }}
        />
      ) : (
        <div
          style={{
            height: "100%",
            display: "grid",
            placeItems: "center",
            color: "var(--text-muted)",
            fontSize: 14,
          }}
        >
          Select a session to open Pi
        </div>
      )}
      {displayError && (
        <div
          role="alert"
          style={{
            position: "absolute",
            inset: 16,
            display: "grid",
            alignContent: "center",
            gap: 8,
            padding: 24,
            color: "var(--error, #ef4444)",
            background: "var(--bg-panel)",
            border: "1px solid currentColor",
            borderRadius: 8,
            zIndex: 1,
          }}
        >
          <strong>{displayErrorTitle(displayError)}</strong>
          <span>{displayError.message}</span>
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            Install the bundled native XAML host, then restart Pi Agent Desktop.
          </span>
        </div>
      )}
    </div>
  );
}
