import { unlinkSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Api, Streams } from "../contract/api";
import { RpcError } from "../contract/types";
import { allowFileRoot } from "./file-access";
import { forkAppendArchived } from "./fork/archive";
import type { AgentSessionWrapper } from "./rpc-manager";
import { invalidateSessionContent } from "./session-content-cache";
import { sessionIndex } from "./session-index";
import { relocateSessionFile } from "./session-relocate";
import { canonicalPathForComparison, validateExistingDirectory } from "./directory-path";

export interface SessionStoreDependencies {
  emit(topic: "sessions.changed", key: string, data: Streams["sessions.changed"]): void;
  getLiveSession(sessionId: string): AgentSessionWrapper | undefined;
  clearSessionEventBinding(sessionId: string): void;
  notifySessionEnded(sessionId: string): Promise<void>;
}

export class SessionStore {
  constructor(private readonly dependencies: SessionStoreDependencies) {}

  async publishChanged(sessionId: string, cwd: string | null): Promise<void> {
    try {
      const filePath = await sessionIndex.resolvePath(sessionId);
      const session = filePath ? await sessionIndex.refreshPath(filePath) : null;
      if (session) {
        this.dependencies.emit("sessions.changed", session.id, {
          cwd: session.cwd,
          sessionId: session.id,
          session,
        });
        return;
      }
    } catch (error) {
      console.error("[agent-host] failed to refresh changed session:", error);
    }
    this.dependencies.emit("sessions.changed", "*", { cwd, fullRefresh: true });
  }

  async delete(params: Api["sessions.delete"]["params"]): Promise<Api["sessions.delete"]["result"]> {
    const { id, force } = params;
    const filePath = await sessionIndex.resolvePath(id);
    if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
    const existing = this.dependencies.getLiveSession(id);
    if (existing?.isAlive()) {
      if (existing.isRunning() && !force) {
        throw new RpcError({
          code: "CONFLICT",
          message: "Session is still running. Stop it before deleting.",
        });
      }
      await existing.abortAndDispose();
      this.dependencies.clearSessionEventBinding(existing.sessionId || id);
    }
    try {
      unlinkSync(filePath);
    } catch (error) {
      throw new RpcError({
        code: "INTERNAL",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    invalidateSessionContent(filePath);
    const deletedSession = sessionIndex.removePath(filePath);
    void this.dependencies.notifySessionEnded(id).catch(() => undefined);
    this.dependencies.emit("sessions.changed", id, {
      cwd: deletedSession?.cwd ?? null,
      sessionId: id,
      deleted: true,
    });
    return { ok: true };
  }

  async rename(params: Api["sessions.rename"]["params"]): Promise<Api["sessions.rename"]["result"]> {
    const { id, name } = params;
    if (!name?.trim()) throw new RpcError({ code: "BAD_REQUEST", message: "name is required" });
    const normalizedName = name.trim();
    const existing = this.dependencies.getLiveSession(id);
    if (existing?.isAlive()) {
      await existing.send({ type: "set_session_name", name: normalizedName });
    } else {
      const filePath = await sessionIndex.resolvePath(id);
      if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
      SessionManager.open(filePath).appendSessionInfo(normalizedName);
      invalidateSessionContent(filePath);
    }
    await this.publishChanged(id, null);
    return { ok: true };
  }

  async setArchived(params: Api["sessions.setArchived"]["params"]): Promise<Api["sessions.setArchived"]["result"]> {
    const { id, archived } = params;
    if (typeof archived !== "boolean") {
      throw new RpcError({ code: "BAD_REQUEST", message: "archived is required" });
    }
    const existing = this.dependencies.getLiveSession(id);
    if (existing?.isAlive()) {
      forkAppendArchived(existing.inner.sessionManager, archived);
    } else {
      const filePath = await sessionIndex.resolvePath(id);
      if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
      forkAppendArchived(SessionManager.open(filePath), archived);
      invalidateSessionContent(filePath);
    }
    await this.publishChanged(id, null);
    if (archived && existing?.isAlive()) {
      void existing.dispose({ abort: true, reason: "archived" });
    }
    return { ok: true };
  }

  async relocate(params: Api["sessions.relocate"]["params"]): Promise<Api["sessions.relocate"]["result"]> {
    const { id, cwd } = params;
    const validation = validateExistingDirectory(cwd);
    if (!validation.ok) throw new RpcError({ code: "BAD_REQUEST", message: validation.error });
    const toCwd = validation.canonicalPath;
    allowFileRoot(toCwd);

    const existing = this.dependencies.getLiveSession(id);
    if (existing?.isAlive()) {
      if (existing.isRunning()) {
        throw new RpcError({
          code: "CONFLICT",
          message: "Session is still running. Stop it before changing the working directory.",
        });
      }
      await existing.abortAndDispose();
      this.dependencies.clearSessionEventBinding(existing.sessionId || id);
    }

    const filePath = await sessionIndex.resolvePath(id);
    if (!filePath) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
    const current = sessionIndex.getByPath(filePath) ?? (await sessionIndex.refreshPath(filePath));
    const fromCwd = current?.cwd ?? SessionManager.open(filePath).getCwd();
    if (canonicalPathForComparison(fromCwd) === canonicalPathForComparison(toCwd)) {
      if (current) return { session: current };
      const session = await sessionIndex.refreshPath(filePath);
      if (!session) throw new RpcError({ code: "NOT_FOUND", message: "Session not found" });
      return { session };
    }

    let destinationPath: string;
    try {
      destinationPath = relocateSessionFile(filePath, fromCwd, toCwd);
    } catch (error) {
      throw new RpcError({
        code: "INTERNAL",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    invalidateSessionContent(filePath);
    invalidateSessionContent(destinationPath);
    sessionIndex.removePath(filePath);
    sessionIndex.rememberPath(id, destinationPath);
    const session = await sessionIndex.refreshPath(destinationPath);
    if (!session) throw new RpcError({ code: "INTERNAL", message: "Session index missed relocated file" });
    this.dependencies.emit("sessions.changed", session.id, {
      cwd: session.cwd,
      sessionId: session.id,
      session,
    });
    return { session };
  }

  async applyNameIfEmpty(sessionId: string, name: string): Promise<boolean> {
    const normalizedName = name.trim();
    if (!normalizedName) return false;

    const liveResult = this.applyLiveNameIfEmpty(sessionId, normalizedName);
    if (liveResult !== null) return liveResult;

    const filePath = await sessionIndex.resolvePath(sessionId);
    if (!filePath) return false;

    const liveResultAfterLookup = this.applyLiveNameIfEmpty(sessionId, normalizedName);
    if (liveResultAfterLookup !== null) return liveResultAfterLookup;

    const manager = SessionManager.open(filePath, undefined);
    const storedName = manager.getSessionName();
    if (typeof storedName === "string" && storedName.trim().length > 0) return false;

    manager.appendSessionInfo(normalizedName);
    invalidateSessionContent(filePath);
    return true;
  }

  private applyLiveNameIfEmpty(sessionId: string, name: string): boolean | null {
    const existing = this.dependencies.getLiveSession(sessionId);
    if (!existing?.isAlive()) return null;
    const currentName = existing.inner.sessionName;
    if (typeof currentName === "string" && currentName.trim().length > 0) return false;
    existing.inner.setSessionName(name);
    return true;
  }
}
