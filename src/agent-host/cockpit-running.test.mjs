import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8");

test("cockpit running unions into the sidebar running set", () => {
  assert.match(source, /export function setCockpitRunning\(/);
  assert.match(source, /export function getRunningSessionIds\(/);
  assert.match(source, /\[\.\.\.getRunningRpcSessionIds\(\), \.\.\.cockpitRunningIds\]/);
  assert.match(source, /const ids = getRunningSessionIds\(\);/);
});
