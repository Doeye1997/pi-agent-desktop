import { useEffect, useState } from "react";

export type SessionDisplayMark = "running" | "dead";

export function forkOnKillSession(sessionId: string): void {
  if (!sessionId.trim()) return;
  window.piBridge.killSessionDisplay?.(sessionId.trim());
}

export function useSessionTuiMarks(): Record<string, SessionDisplayMark> {
  const [marks, setMarks] = useState<Record<string, SessionDisplayMark>>({});

  useEffect(() => {
    let cancelled = false;
    const apply = (next: Record<string, SessionDisplayMark>) => {
      if (!cancelled) setMarks(next);
    };
    void window.piBridge
      .getSessionDisplayMarks?.()
      .then(apply)
      .catch(() => undefined);
    const unsubscribe = window.piBridge.onSessionDisplayMarks?.(apply);
    const timer = window.setInterval(() => {
      void window.piBridge
        .getSessionDisplayMarks?.()
        .then(apply)
        .catch(() => undefined);
    }, 2000);
    return () => {
      cancelled = true;
      unsubscribe?.();
      window.clearInterval(timer);
    };
  }, []);

  return marks;
}
