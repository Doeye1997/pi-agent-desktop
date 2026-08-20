export function forkOnSelectSession(session: { id?: string; path?: string; cwd?: string }, remount = false): void {
  const sessionId = session.id?.trim();
  const sessionPath = session.path?.trim();
  const cwd = session.cwd?.trim();
  if (!sessionId || !cwd) return;
  window.piBridge.startSessionDisplay?.({
    sessionId,
    ...(sessionPath ? { sessionPath } : {}),
    cwd,
    ...(remount ? { remount: true } : {}),
  });
}

export function forkOnNewSession(sessionId: string, cwd: string): void {
  forkOnSelectSession({ id: sessionId, cwd });
}
