import { useEffect, useRef, useState } from "react";
import type { SessionDisplayBounds, SessionDisplayError } from "@shared/session-display";

type TerminalSession = {
  id: string;
  cwd: string;
  path?: string;
};

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

export function EmbeddedPiTerminal({ session, theme }: { session: TerminalSession | null; theme: "light" | "dark" }) {
  const root = useRef<HTMLDivElement | null>(null);
  const selectedSessionId = useRef<string | null>(session?.id ?? null);
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
    window.piBridge.setSessionDisplayTheme(theme);
  }, [theme]);

  useEffect(() => {
    const element = root.current;
    const sessionId = session?.id;
    if (!element || !sessionId) return;

    const publishBounds = () => {
      const bounds = readDisplayBounds(element);
      if (!bounds || selectedSessionId.current !== sessionId) return;
      window.piBridge.setSessionDisplayBounds(sessionId, bounds);
    };
    const observer = new ResizeObserver(publishBounds);
    observer.observe(element);
    publishBounds();
    window.addEventListener("resize", publishBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publishBounds);
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
