import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-session-store-"));
const sessionsRoot = path.join(fixtureRoot, "sessions");
const sourceCwd = path.join(fixtureRoot, "source");
const destinationCwd = path.join(fixtureRoot, "destination");
mkdirSync(sourceCwd, { recursive: true });
mkdirSync(destinationCwd, { recursive: true });
process.env.PI_CODING_AGENT_DIR = fixtureRoot;
process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;
test.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

const { SessionStore } = await importTestBundle("src/agent-host/session-store", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "session-store.ts")],
});
const { defaultSessionDirForCwd } = await import("./session-relocate.ts");
const { resolveSessionPath } = await importTestBundle("src/agent-host/session-reader", {
  packages: "external",
  entryPoints: [path.join(import.meta.dirname, "session-reader.ts")],
});

function writeSession(id) {
  const sessionDirectory = defaultSessionDirForCwd(sourceCwd);
  mkdirSync(sessionDirectory, { recursive: true });
  const sessionPath = path.join(sessionDirectory, `${id}.jsonl`);
  writeFileSync(
    sessionPath,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-08-22T00:00:00.000Z",
      cwd: sourceCwd,
    })}\n`,
    "utf8",
  );
  return sessionPath;
}

function createStore() {
  const emitted = [];
  const ended = [];
  const store = new SessionStore({
    emit(topic, key, data) {
      emitted.push({ topic, key, data });
    },
    getLiveSession() {
      return undefined;
    },
    clearSessionEventBinding() {},
    async notifySessionEnded(sessionId) {
      ended.push(sessionId);
    },
  });
  return { store, emitted, ended };
}

test("relocate owns persistence, indexing, and change publication", async () => {
  const sourcePath = writeSession("relocate-owned");
  const { store, emitted } = createStore();

  const relocated = await store.relocate({ id: "relocate-owned", cwd: destinationCwd });

  const canonicalDestination = (realpathSync.native ?? realpathSync)(destinationCwd);
  assert.equal(relocated.session.cwd, canonicalDestination);
  assert.equal(existsSync(sourcePath), false);
  const destinationPath = await resolveSessionPath("relocate-owned");
  assert.ok(destinationPath);
  assert.equal(existsSync(destinationPath), true);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].topic, "sessions.changed");
  assert.equal(emitted[0].key, "relocate-owned");
  assert.equal(emitted[0].data.session.id, "relocate-owned");
});

test("archive and delete coordinate persistence, indexing, and cleanup", async () => {
  const sessionPath = writeSession("archive-delete-owned");
  const { store, emitted, ended } = createStore();

  await store.setArchived({ id: "archive-delete-owned", archived: true });
  const archived = emitted.at(-1).data.session;
  assert.equal(archived.archived, true);

  await store.delete({ id: "archive-delete-owned" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(existsSync(sessionPath), false);
  assert.deepEqual(ended, ["archive-delete-owned"]);
  assert.equal(emitted.at(-1).data.deleted, true);
  assert.equal(await resolveSessionPath("archive-delete-owned"), null);
});

test("conditional automatic names never replace manual names", async () => {
  const guardedPath = writeSession("auto-title-guarded-store");
  const concurrentPath = writeSession("auto-title-concurrent-store");
  const { store } = createStore();

  assert.equal(await store.applyNameIfEmpty("auto-title-guarded-store", "Automatic title"), true);
  await store.rename({ id: "auto-title-guarded-store", name: "Manual title" });
  assert.equal(await store.applyNameIfEmpty("auto-title-guarded-store", "Late automatic title"), false);
  assert.equal(SessionManager.open(guardedPath).getSessionName(), "Manual title");

  await Promise.all([
    store.applyNameIfEmpty("auto-title-concurrent-store", "Automatic title"),
    store.rename({ id: "auto-title-concurrent-store", name: "Concurrent manual title" }),
  ]);
  assert.equal(SessionManager.open(concurrentPath).getSessionName(), "Concurrent manual title");
});
