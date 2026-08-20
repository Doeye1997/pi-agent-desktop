import assert from "node:assert/strict";
import test from "node:test";

import { assertHostReadyForUpdate, updateBlockingSessionCount } from "./host-update-policy.ts";

test("Host unavailability keeps update installation blocked", () => {
  assert.equal(updateBlockingSessionCount("starting", 0), 1);
  assert.equal(updateBlockingSessionCount("crashed", 2), 2);
  assert.equal(updateBlockingSessionCount("ready", 0), 0);
  assert.throws(() => assertHostReadyForUpdate("starting"), /must be connected/);
  assert.doesNotThrow(() => assertHostReadyForUpdate("ready"));
});
