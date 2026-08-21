import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("development staging keeps an existing native asset when the live Host locks it", () => {
  const source = readFileSync(new URL("./prepare-windows-terminal-host.mjs", import.meta.url), "utf8");

  assert.match(source, /error\.code === "EBUSY" \|\| error\.code === "EPERM"/);
  assert.match(source, /if \(!targetIsLocked \|\| !existsSync\(target\)\) throw error/);
  assert.match(
    source,
    /refreshAsset\(firstExisting\(\[hostSource\], "pi-session-display-host\.exe"\), stageRoot, "pi-session-display-host\.exe"\)/,
  );
});
