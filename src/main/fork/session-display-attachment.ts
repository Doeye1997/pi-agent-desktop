import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import type { SessionDisplaySession } from "../../shared/session-display";

type SessionDisplaySelection = Pick<SessionDisplaySession, "sessionId" | "sessionPath" | "cwd"> & {
  remount?: boolean;
};

export function createLatestSessionDisplayStarter(options: {
  resolveNodeExecutable: (cwd: string) => Promise<string>;
  program: () => string;
  start: (session: SessionDisplaySession, remount: boolean) => void;
  onError: (selection: SessionDisplaySelection, error: unknown) => void;
}) {
  let latestSelection = 0;
  let pendingSessionId: string | null = null;
  return {
    async start(selection: SessionDisplaySelection): Promise<void> {
      const selectionNumber = ++latestSelection;
      pendingSessionId = selection.sessionId;
      try {
        const nodeExecutable = await options.resolveNodeExecutable(selection.cwd);
        if (selectionNumber !== latestSelection) return;
        pendingSessionId = null;
        const { remount = false, ...session } = selection;
        options.start(
          {
            ...session,
            nodeExecutable,
            program: options.program(),
          },
          remount,
        );
      } catch (error) {
        if (selectionNumber !== latestSelection) return;
        pendingSessionId = null;
        options.onError(selection, error);
      }
    },
    cancel(sessionId: string): void {
      if (pendingSessionId !== sessionId) return;
      latestSelection += 1;
      pendingSessionId = null;
    },
  };
}

export function bundledPiCliPath(): string {
  const packageJsonPath = findPackageJSON(
    "@earendil-works/pi-coding-agent",
    typeof __filename === "string" ? __filename : import.meta.url,
  );
  if (!packageJsonPath) throw new Error("Bundled Pi package not found");
  return join(dirname(packageJsonPath), "dist", "cli.js");
}
