import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("Agent Host owns native session display implementation", () => {
  const servicePath = path.join(import.meta.dirname, "session-display-service.ts");
  const serviceSource = readFileSync(servicePath, "utf8");
  assert.doesNotMatch(serviceSource, /\.\.\/main\//);
  for (const fileName of ["session-display.ts", "windows-terminal-host.ts", "tui-running-protocol.ts"]) {
    assert.equal(existsSync(path.join(import.meta.dirname, "fork", fileName)), true, fileName);
  }
});
