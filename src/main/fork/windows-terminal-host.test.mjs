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

test("Windows Terminal staging preserves the nested TermControl XAML resources", () => {
  const prepareScriptPath = fileURLToPath(
    new URL("../../../scripts/prepare-windows-terminal-host.mjs", import.meta.url),
  );
  const prepareScript = readFileSync(prepareScriptPath, "utf8");

  assert.match(prepareScript, /"Microsoft\.Terminal\.Control\/TermControl\.xbf"/);
  assert.match(prepareScript, /"Microsoft\.Terminal\.Control\/SearchBoxControl\.xbf"/);
});

test("native host mounts an IME TextBox overlay and submits one complete line", () => {
  const hostSourcePath = fileURLToPath(
    new URL("../../../native/wt-xaml-island/pi-session-display-host.cpp", import.meta.url),
  );
  const hostSource = readFileSync(hostSourcePath, "utf8");

  assert.match(hostSource, /auto root = Grid\{\};[\s\S]*root\.Children\(\)\.Append\(control\)/);
  assert.match(hostSource, /auto composer = TextBox\{\}/);
  assert.match(hostSource, /composerCard\.VerticalAlignment\(VerticalAlignment::Bottom\)/);
  assert.match(hostSource, /composerCard\.Margin\(Thickness\{ 0\.0, 0\.0, 0\.0, 0\.0 \}\)/);
  assert.match(hostSource, /composerCard\.CornerRadius\(winrt::Windows::UI::Xaml::CornerRadius\{ 0\.0, 0\.0, 0\.0, 0\.0 \}\)/);
  assert.match(hostSource, /composer\.Height\(52\.0\)/);
  assert.match(hostSource, /VariableSizedWrapGrid/);
  assert.match(hostSource, /Chrome_RenderWidgetHostHWND/);
  assert.match(hostSource, /args\.Handled\(true\)/);
  assert.match(hostSource, /payload\.push_back\(u'\\r'\)/);

  const writeIndex = hostSource.indexOf("connection.WriteInput(payload)");
  const clearIndex = hostSource.indexOf("sender.as<TextBox>().Text(winrt::hstring{})");
  assert.ok(writeIndex >= 0);
  assert.ok(clearIndex > writeIndex);
  assert.match(hostSource, /termControl\.PointerPressed\([\s\S]*Focus\(FocusState::Pointer\)/);
});

test("native TermControl keeps Ctrl+C interrupt semantics while supporting selection copy and paste", () => {
  const hostSourcePath = fileURLToPath(
    new URL("../../../native/wt-xaml-island/pi-session-display-host.cpp", import.meta.url),
  );
  const hostSource = readFileSync(hostSourcePath, "utf8");

  assert.match(hostSource, /termControl\.WriteToClipboard\(/);
  assert.match(hostSource, /termControl\.PasteFromClipboard\(/);
  assert.match(hostSource, /termControl\.KeyBindings\(keyBindings\.as<IKeyBindings>\(\)\)/);
  assert.match(hostSource, /CopySelectionToClipboard\(true, false, false, CopyFormat::None\)/);
  assert.match(hostSource, /return _control\.CopySelectionToClipboard\(/);
  assert.match(hostSource, /VirtualKey::V[\s\S]*PasteTextFromClipboard\(\)[\s\S]*return true/);
});
