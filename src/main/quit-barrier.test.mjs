import assert from "node:assert/strict";
import test from "node:test";

import { createQuitBarrier } from "./quit-barrier.ts";

test("quit barrier waits for completed detach and coalesces repeated quit events", async () => {
  let releaseDetach;
  let detachCalls = 0;
  let cleanupCalls = 0;
  let quitCalls = 0;
  const barrier = createQuitBarrier({
    detach: () => {
      detachCalls += 1;
      return new Promise((resolve) => {
        releaseDetach = resolve;
      });
    },
    cleanup: async () => {
      cleanupCalls += 1;
    },
    quit: () => {
      quitCalls += 1;
    },
    log: () => undefined,
  });
  const first = { prevented: false, preventDefault() { this.prevented = true; } };
  const repeated = { prevented: false, preventDefault() { this.prevented = true; } };

  barrier.handleBeforeQuit(first);
  barrier.handleBeforeQuit(repeated);
  assert.equal(first.prevented, true);
  assert.equal(repeated.prevented, true);
  assert.equal(detachCalls, 1);
  assert.equal(quitCalls, 0);

  releaseDetach();
  await barrier.wait();
  assert.equal(cleanupCalls, 1);
  assert.equal(quitCalls, 1);

  const released = { prevented: false, preventDefault() { this.prevented = true; } };
  barrier.handleBeforeQuit(released);
  assert.equal(released.prevented, false);
});

test("quit barrier records detach failure but still releases Electron", async () => {
  const logs = [];
  let cleaned = false;
  let quitCalls = 0;
  const barrier = createQuitBarrier({
    detach: async () => {
      throw new Error("detach timeout");
    },
    cleanup: async () => {
      cleaned = true;
    },
    quit: () => {
      quitCalls += 1;
    },
    log: (message) => logs.push(message),
  });

  barrier.handleBeforeQuit({ preventDefault() {} });
  await barrier.wait();
  assert.equal(cleaned, true);
  assert.equal(quitCalls, 1);
  assert.match(logs.join("\n"), /detach timeout/);
});
