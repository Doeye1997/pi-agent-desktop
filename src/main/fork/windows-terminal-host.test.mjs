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
  assert.match(
    hostSource,
    /composerCard\.CornerRadius\(winrt::Windows::UI::Xaml::CornerRadius\{ 0\.0, 0\.0, 0\.0, 0\.0 \}\)/,
  );
  assert.match(hostSource, /composer\.Height\(52\.0\)/);
  assert.match(hostSource, /composer\.AcceptsReturn\(false\)/);
  assert.match(hostSource, /composerCard\.BorderThickness\(Thickness\{ 0\.0, 1\.0, 0\.0, 0\.0 \}\)/);
  assert.match(
    hostSource,
    /dockRow\.Children\(\)\.Append\(cwdCombo\);[\s\S]*worktreeCombo[\s\S]*usageText[\s\S]*modelCombo[\s\S]*thinkingCombo[\s\S]*mcpText/,
  );
  assert.doesNotMatch(hostSource, /SendButton|Button\{\}/);
  assert.match(hostSource, /Grid::SetColumn\(usageText, 2\)/);
  assert.doesNotMatch(hostSource, /VariableSizedWrapGrid/);
  assert.match(hostSource, /selectedIndex < 0 && !currentLabel.empty\(\) && label == currentLabel/);
  assert.match(hostSource, /combo\.Items\(\)\.InsertAt\(0, current\)/);
  assert.match(hostSource, /Chrome_RenderWidgetHostHWND/);
  assert.match(hostSource, /args\.Handled\(true\)/);
  assert.match(hostSource, /payload\.push_back\(u'\\r'\)/);

  const writeIndex = hostSource.indexOf("connection.WriteInput(payload)");
  const clearIndex = hostSource.indexOf("sender.as<TextBox>().Text(winrt::hstring{})");
  assert.ok(writeIndex >= 0);
  assert.ok(clearIndex > writeIndex);
  assert.match(hostSource, /termControl\.PointerPressed\([\s\S]*Focus\(FocusState::Pointer\)/);
});

test("native host skill picker stays in-tree and filters slash input", () => {
  const hostSourcePath = fileURLToPath(
    new URL("../../../native/wt-xaml-island/pi-session-display-host.cpp", import.meta.url),
  );
  const hostSource = readFileSync(hostSourcePath, "utf8");

  assert.doesNotMatch(hostSource, /MenuFlyout/);
  assert.doesNotMatch(hostSource, /ListView/);
  assert.match(hostSource, /auto skillPicker = ScrollViewer\{\}/);
  assert.match(hostSource, /AllowFocusOnInteraction\(false\)/);
  assert.match(hostSource, /keepComposerFocused/);
  assert.match(hostSource, /std::optional<std::wstring> slashQuery/);
  assert.match(hostSource, /VirtualKey::Down/);
  assert.match(hostSource, /applySelectedSkill/);
  assert.match(hostSource, /composerStack\.Children\(\)\.Append\(skillPickerChrome\)/);
  assert.match(hostSource, /splitSkillLabel/);
  assert.match(hostSource, /pickerRowActive/);
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

test("native host parks sessions across Electron replacement and reparents them without respawning Pi", () => {
  const hostSourcePath = fileURLToPath(
    new URL("../../../native/wt-xaml-island/pi-session-display-host.cpp", import.meta.url),
  );
  const hostSource = readFileSync(hostSourcePath, "utf8");

  assert.match(hostSource, /void detachSessionHostWindow\(HWND window, HWND parkingWindow\)/);
  assert.match(hostSource, /SetParent\(window, parkingWindow\)/);
  assert.match(hostSource, /_parkingWindow = createSessionHostWindow\(\)/);
  assert.match(hostSource, /else if \(type == L"detach"\)[\s\S]*host\.detach\(\)/);
  assert.match(hostSource, /else if \(type == L"attach"\)[\s\S]*host\.attach/);
  assert.match(
    hostSource,
    /if \(find\(request\.sessionId\)\)[\s\S]*ensureSessionHostWindow\(session, parentHandle\)[\s\S]*focus\(request\.sessionId\)/,
  );
  assert.match(hostSource, /isInvalidParentWindowFailure[\s\S]*type == L"attach" \|\| type == L"bounds"/);
  assert.match(hostSource, /if \(session->host && IsWindow\(session->host\)\)/);
  assert.match(hostSource, /session->xamlSource = std::move\(source\)/);
  assert.match(hostSource, /attachSessionHostWindow\(session->host, parentHandle\)/);
  assert.match(hostSource, /electronContentOrigin\(session->browserParent\)/);
  assert.match(hostSource, /x \+ contentOrigin\.x[\s\S]*y \+ contentOrigin\.y/);
  assert.match(hostSource, /host\.detach\(\);[\s\S]*emitAck\(namedString\(command, L"requestId"\)\)/);
});
