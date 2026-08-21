import { importTestBundle } from "#test-bundle";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const { installWindowsSafeWatch } = await importTestBundle("src/agent-host/windows-safe-watch", {
  entryPoints: [path.join(import.meta.dirname, "windows-safe-watch.ts")],
  packages: "external",
});

test("Windows safe watch reports file changes without invoking libuv fs events", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-safe-watch-"));
  const filePath = path.join(directory, "session.jsonl");
  writeFileSync(filePath, "first", "utf8");
  const restore = installWindowsSafeWatch({ platform: "win32", intervalMs: 20 });
  t.after(() => {
    restore();
    rmSync(directory, { recursive: true, force: true });
  });

  const changed = new Promise((resolve, reject) => {
    const watcher = fs.watch(directory, (_event, filename) => {
      if (filename !== "session.jsonl") return;
      watcher.close();
      resolve(filename);
    });
    setTimeout(() => reject(new Error("safe watcher did not report the change")), 1000).unref();
  });
  writeFileSync(filePath, "second", "utf8");
  assert.equal(await changed, "session.jsonl");
});
