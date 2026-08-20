#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function firstExisting(paths, label) {
  const match = paths.find((candidate) => existsSync(candidate));
  if (!match) throw new Error(`Windows Terminal host asset is missing: ${label}`);
  return match;
}

function copyAsset(source, targetRoot, targetName = path.basename(source)) {
  const target = path.join(targetRoot, targetName);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
  return `${targetName} (${statSync(source).size} bytes)`;
}

function findWindowsAppCrtRoot() {
  const windowsRoot = process.env.SystemRoot?.trim();
  if (!windowsRoot) return undefined;
  const sideBySideRoot = path.join(windowsRoot, "WinSxS");
  if (!existsSync(sideBySideRoot)) return undefined;
  return readdirSync(sideBySideRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("amd64_userexperience-core_"))
    .map((entry) => path.join(sideBySideRoot, entry.name, "Core"))
    .filter((candidate) => existsSync(path.join(candidate, "msvcp140_app.dll")))
    .sort()
    .at(-1);
}

function main() {
  if (process.platform !== "win32") {
    console.log("[windows-terminal-host] skipped on non-Windows");
    return;
  }

  if (process.arch !== "x64") {
    throw new Error(`Windows Terminal XAML host currently supports x64 only (received ${process.arch})`);
  }

  const stageRoot = path.join(root, "build", "toolchains", "windows-terminal", "win-x64");
  const stagedAssetNames = [
    "pi-session-display-host.exe",
    "Microsoft.Toolkit.Win32.UI.XamlHost.dll",
    "Microsoft.UI.Xaml.dll",
    "resources.pri",
    "Microsoft.Terminal.Control.dll",
    "TerminalConnection.dll",
    "OpenConsole.exe",
    "Microsoft.Terminal.UI.dll",
    "msvcp140.dll",
    "msvcp140_app.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "vcruntime140_app.dll",
    "vcruntime140_1_app.dll",
    "TermControl.xbf",
    "SearchBoxControl.xbf",
    "Microsoft.Terminal.Control/TermControl.xbf",
    "Microsoft.Terminal.Control/SearchBoxControl.xbf",
  ];
  const hostSource = path.join(root, "native", "wt-xaml-island", "pi-session-display-host.exe");
  const xamlApplicationCandidates = [
    process.env.PI_WINDOWS_TERMINAL_XAML_APPLICATION_ROOT?.trim(),
    path.join(
      root,
      "build",
      "toolchains",
      "Microsoft.Toolkit.Win32.UI.XamlApplication.6.1.3",
      "runtimes",
      "win10-x64",
      "native",
    ),
    path.join(root, "native", "wt-xaml-island"),
  ].filter(Boolean);
  mkdirSync(stageRoot, { recursive: true });
  copyAsset(firstExisting([hostSource], "pi-session-display-host.exe"), stageRoot, "pi-session-display-host.exe");
  const xamlApplicationRoot = firstExisting(
    xamlApplicationCandidates,
    "PI_WINDOWS_TERMINAL_XAML_APPLICATION_ROOT or extracted Microsoft.Toolkit.Win32.UI.XamlApplication 6.1.3",
  );
  copyAsset(
    firstExisting(
      [path.join(xamlApplicationRoot, "Microsoft.Toolkit.Win32.UI.XamlHost.dll")],
      "Microsoft.Toolkit.Win32.UI.XamlHost.dll",
    ),
    stageRoot,
    "Microsoft.Toolkit.Win32.UI.XamlHost.dll",
  );
  const appCrtRoot = firstExisting(
    [process.env.PI_WINDOWS_TERMINAL_APP_CRT_ROOT?.trim(), findWindowsAppCrtRoot()].filter(Boolean),
    "PI_WINDOWS_TERMINAL_APP_CRT_ROOT or Windows App CRT",
  );
  for (const name of ["msvcp140_app.dll", "vcruntime140_app.dll", "vcruntime140_1_app.dll"]) {
    copyAsset(firstExisting([path.join(appCrtRoot, name)], name), stageRoot, name);
  }
  if (stagedAssetNames.every((name) => existsSync(path.join(stageRoot, name)))) {
    console.log(`[windows-terminal-host] existing staging is complete at ${stageRoot}`);
    return;
  }

  const terminalRoot = process.env.PI_WINDOWS_TERMINAL_ROOT?.trim();
  const runtimeSource = process.env.PI_WINDOWS_TERMINAL_RUNTIME_SOURCE?.trim();
  const runtimeCandidates = [
    runtimeSource,
    terminalRoot && path.join(terminalRoot, "bin", "x64", "Release"),
    terminalRoot && path.join(terminalRoot, "bin", "x64", "Debug"),
  ].filter(Boolean);
  const sourceRoot = firstExisting(
    runtimeCandidates,
    "PI_WINDOWS_TERMINAL_RUNTIME_SOURCE or PI_WINDOWS_TERMINAL_ROOT/bin/x64/{Release,Debug}",
  );
  const uiRoot = firstExisting(
    [process.env.PI_WINDOWS_TERMINAL_UIXAML_ROOT?.trim(), sourceRoot].filter(Boolean),
    "PI_WINDOWS_TERMINAL_UIXAML_ROOT",
  );
  const mergedPri = firstExisting(
    [
      process.env.PI_WINDOWS_TERMINAL_PRI_PATH?.trim(),
      path.join(sourceRoot, "WindowsTerminal", "resources.pri"),
    ].filter(Boolean),
    "PI_WINDOWS_TERMINAL_PRI_PATH or the Windows Terminal unpackaged Application PRI",
  );
  const crtRoot = firstExisting(
    [
      process.env.PI_WINDOWS_TERMINAL_CRT_ROOT?.trim(),
      process.env.VCToolsRedistDir?.trim() &&
        path.join(process.env.VCToolsRedistDir.trim(), "x64", "Microsoft.VC145.CRT"),
    ].filter(Boolean),
    "PI_WINDOWS_TERMINAL_CRT_ROOT or VCToolsRedistDir",
  );
  const controlRoot = path.join(sourceRoot, "Microsoft.Terminal.Control");
  const controlXamlRoot = path.join(controlRoot, "Microsoft.Terminal.Control");
  const controlLibraryRoot = path.join(sourceRoot, "Microsoft.Terminal.Control.Lib");
  const assets = [
    [hostSource, "pi-session-display-host.exe"],
    [
      firstExisting(
        [path.join(xamlApplicationRoot, "Microsoft.Toolkit.Win32.UI.XamlHost.dll")],
        "Microsoft.Toolkit.Win32.UI.XamlHost.dll",
      ),
      "Microsoft.Toolkit.Win32.UI.XamlHost.dll",
    ],
    [firstExisting([path.join(uiRoot, "Microsoft.UI.Xaml.dll")], "Microsoft.UI.Xaml.dll"), "Microsoft.UI.Xaml.dll"],
    [mergedPri, "resources.pri"],
    [
      firstExisting([path.join(controlRoot, "Microsoft.Terminal.Control.dll")], "Microsoft.Terminal.Control.dll"),
      "Microsoft.Terminal.Control.dll",
    ],
    [
      firstExisting([path.join(sourceRoot, "TerminalConnection", "TerminalConnection.dll")], "TerminalConnection.dll"),
      "TerminalConnection.dll",
    ],
    [firstExisting([path.join(sourceRoot, "OpenConsole.exe")], "OpenConsole.exe"), "OpenConsole.exe"],
    [
      firstExisting(
        [path.join(sourceRoot, "Microsoft.Terminal.UI", "Microsoft.Terminal.UI.dll")],
        "Microsoft.Terminal.UI.dll",
      ),
      "Microsoft.Terminal.UI.dll",
    ],
    [firstExisting([path.join(crtRoot, "msvcp140.dll")], "msvcp140.dll"), "msvcp140.dll"],
    [firstExisting([path.join(appCrtRoot, "msvcp140_app.dll")], "msvcp140_app.dll"), "msvcp140_app.dll"],
    [firstExisting([path.join(crtRoot, "vcruntime140.dll")], "vcruntime140.dll"), "vcruntime140.dll"],
    [firstExisting([path.join(crtRoot, "vcruntime140_1.dll")], "vcruntime140_1.dll"), "vcruntime140_1.dll"],
    [firstExisting([path.join(appCrtRoot, "vcruntime140_app.dll")], "vcruntime140_app.dll"), "vcruntime140_app.dll"],
    [
      firstExisting([path.join(appCrtRoot, "vcruntime140_1_app.dll")], "vcruntime140_1_app.dll"),
      "vcruntime140_1_app.dll",
    ],
    [
      firstExisting(
        [path.join(controlXamlRoot, "TermControl.xbf"), path.join(controlLibraryRoot, "TermControl.xbf")],
        "TermControl.xbf",
      ),
      "TermControl.xbf",
    ],
    [
      firstExisting(
        [path.join(controlXamlRoot, "SearchBoxControl.xbf"), path.join(controlLibraryRoot, "SearchBoxControl.xbf")],
        "SearchBoxControl.xbf",
      ),
      "SearchBoxControl.xbf",
    ],
    [
      firstExisting(
        [path.join(controlXamlRoot, "TermControl.xbf"), path.join(controlLibraryRoot, "TermControl.xbf")],
        "Microsoft.Terminal.Control/TermControl.xbf",
      ),
      "Microsoft.Terminal.Control/TermControl.xbf",
    ],
    [
      firstExisting(
        [path.join(controlXamlRoot, "SearchBoxControl.xbf"), path.join(controlLibraryRoot, "SearchBoxControl.xbf")],
        "Microsoft.Terminal.Control/SearchBoxControl.xbf",
      ),
      "Microsoft.Terminal.Control/SearchBoxControl.xbf",
    ],
  ];

  console.log(`[windows-terminal-host] staging ${assets.length} assets to ${stageRoot}`);
  for (const [source, targetName] of assets) {
    console.log(`  ${copyAsset(source, stageRoot, targetName)}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
