import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveWindowsTerminalHostPath, WINDOWS_TERMINAL_HOST_FILENAME } from "./windows-terminal-host.ts";

test("development resolution prefers the complete Windows Terminal staging directory", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-wt-host-"));
  const stage = join(root, "build", "toolchains", "windows-terminal", "win-x64");
  mkdirSync(stage, { recursive: true });
  const stagedHost = join(stage, WINDOWS_TERMINAL_HOST_FILENAME);
  writeFileSync(stagedHost, "stub");

  assert.equal(resolveWindowsTerminalHostPath({}, join(root, "resources"), root), stagedHost);
});

test("Windows Terminal staging includes the matching side-by-side console server", () => {
  const prepareScriptPath = fileURLToPath(
    new URL("../../../scripts/prepare-windows-terminal-host.mjs", import.meta.url),
  );
  const prepareScript = readFileSync(prepareScriptPath, "utf8");

  assert.match(prepareScript, /stagedAssetNames = \[[\s\S]*"OpenConsole\.exe"/);
  assert.match(prepareScript, /path\.join\(sourceRoot, "OpenConsole\.exe"\)[\s\S]*"OpenConsole\.exe"/);
});
