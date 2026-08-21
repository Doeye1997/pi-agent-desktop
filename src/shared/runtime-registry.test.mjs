import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createRuntimeOwner,
  nextRuntimeGeneration,
  readRuntimeRegistry,
  removeRuntimeRegistry,
  renewRuntimeRegistry,
  writeRuntimeRegistry,
} from "./runtime-registry.ts";

test("runtime registry fences stale owners from overwrite and removal", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-runtime-registry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const first = createRuntimeOwner({ pid: 101, generation: 1, processStartedAt: "2026-08-21T01:00:00.000Z" });
  const second = createRuntimeOwner({ pid: 202, generation: 2, processStartedAt: "2026-08-21T02:00:00.000Z" });
  writeRuntimeRegistry(directory, {
    owner: first,
    endpoint: { port: 4101, token: "a".repeat(64) },
    protocolVersion: 1,
    hostVersion: "first",
    sessions: {},
  });
  writeRuntimeRegistry(directory, {
    owner: second,
    endpoint: { port: 4102, token: "b".repeat(64) },
    protocolVersion: 1,
    hostVersion: "second",
    sessions: {},
  });

  assert.equal(renewRuntimeRegistry(directory, first, {}), false);
  assert.equal(removeRuntimeRegistry(directory, first), false);
  assert.equal(readRuntimeRegistry(directory)?.owner.ownerToken, second.ownerToken);
  assert.equal(removeRuntimeRegistry(directory, second), true);
  assert.equal(readRuntimeRegistry(directory), null);
});

test("runtime generation remains monotonic after a clean registry removal", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-runtime-generation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  assert.equal(nextRuntimeGeneration(directory), 1);
  const owner = createRuntimeOwner({ pid: 404, generation: 1 });
  writeRuntimeRegistry(directory, {
    owner,
    endpoint: { port: 4404, token: "d".repeat(64) },
    protocolVersion: 1,
    hostVersion: "first",
    sessions: {},
  });
  assert.equal(removeRuntimeRegistry(directory, owner), true);
  assert.equal(nextRuntimeGeneration(directory), 2);
});

test("runtime registry persists lease and explicit session lifecycle", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-runtime-registry-state-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const owner = createRuntimeOwner({ pid: 303, generation: 7, processStartedAt: "2026-08-21T03:00:00.000Z" });
  writeRuntimeRegistry(directory, {
    owner,
    endpoint: { port: 4303, token: "c".repeat(64) },
    protocolVersion: 1,
    hostVersion: "stateful",
    sessions: { alpha: "running-attached" },
  });
  const initial = readRuntimeRegistry(directory);
  assert.equal(initial?.schemaVersion, 1);
  assert.equal(initial?.owner.generation, 7);
  assert.equal(initial?.sessions.alpha, "running-attached");
  assert.ok(Date.parse(initial?.lease.expiresAt ?? "") > Date.parse(initial?.lease.renewedAt ?? ""));

  assert.equal(renewRuntimeRegistry(directory, owner, { alpha: "running-detached", beta: "orphaned" }), true);
  assert.deepEqual(readRuntimeRegistry(directory)?.sessions, {
    alpha: "running-detached",
    beta: "orphaned",
  });
});
