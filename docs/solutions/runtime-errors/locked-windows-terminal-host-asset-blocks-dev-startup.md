---
title: Locked Windows Terminal host asset blocks development startup
date: 2026-08-20
category: runtime-errors
module: Windows Terminal host asset staging
problem_type: runtime_error
component: development_workflow
symptoms:
  - "npm run dev exits before Electron opens with EBUSY while copying pi-session-display-host.exe into the staging directory"
  - "A detached Agent Host preserves Pi sessions and keeps the staged native host executable locked across Electron lifecycles"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - tooling
tags: [windows-terminal, agent-host, asset-staging, file-lock, electron, dev-startup]
---

# Locked Windows Terminal host asset blocks development startup

## Problem

On Windows, a second development startup could fail while staging the native Windows Terminal host. During this session, a still-running native host appeared to hold `build/toolchains/windows-terminal/win-x64/pi-session-display-host.exe` open while the preparation script attempted to overwrite it, producing `EBUSY` before Electron started.

## Symptoms

- `npm run dev` reports `EBUSY: resource busy or locked` for `pi-session-display-host.exe`, then exits without opening the desktop window.
- Re-running the command produces the same error while the detached Agent Host remains alive.
- The initial TypeScript build may succeed independently, making the failure look unrelated to the application code.

The preparation subprocess and initial build are both awaited before watchers or Electron start ([`scripts/dev.mjs:268`](../../../scripts/dev.mjs), [`scripts/dev.mjs:277`](../../../scripts/dev.mjs)). A preparation failure therefore aborts the entire development launch.

## What Didn't Work

- Re-running development did not release the file. The Agent Host is intentionally spawned detached and unreferenced so it can survive Electron replacement ([`scripts/dev.mjs:78`](../../../scripts/dev.mjs), [`scripts/dev.mjs:85`](../../../scripts/dev.mjs), [`scripts/dev.mjs:98`](../../../scripts/dev.mjs)).
- The staging completeness check could not prevent the error because the preparation script refreshed the host executable before reaching that check ([`prepare-windows-terminal-host.mjs:96`](../../../scripts/prepare-windows-terminal-host.mjs), [`prepare-windows-terminal-host.mjs:116`](../../../scripts/prepare-windows-terminal-host.mjs)).
- Excluding `*.test.mjs` from the `tsup` watcher fixes unnecessary Electron restarts after test edits, but not this separate startup-time copy failure.

## Solution

Keep the normal copy path, but treat a locked existing target as a recoverable refresh condition:

```js
function refreshAsset(source, targetRoot, targetName = path.basename(source)) {
  const target = path.join(targetRoot, targetName);
  try {
    return copyAsset(source, targetRoot, targetName);
  } catch (error) {
    const targetIsLocked =
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "EBUSY" || error.code === "EPERM");
    if (!targetIsLocked || !existsSync(target)) throw error;
    return `${targetName} (kept existing locked asset)`;
  }
}
```

The guard suppresses only `EBUSY` or `EPERM` when the target already exists; missing targets and unrelated filesystem errors still fail ([`prepare-windows-terminal-host.mjs:22`](../../../scripts/prepare-windows-terminal-host.mjs), [`prepare-windows-terminal-host.mjs:31`](../../../scripts/prepare-windows-terminal-host.mjs), [`prepare-windows-terminal-host.mjs:32`](../../../scripts/prepare-windows-terminal-host.mjs)). The native host, XAML host DLL, and App CRT refreshes use this helper before the complete-stage check ([`prepare-windows-terminal-host.mjs:96`](../../../scripts/prepare-windows-terminal-host.mjs), [`prepare-windows-terminal-host.mjs:101`](../../../scripts/prepare-windows-terminal-host.mjs), [`prepare-windows-terminal-host.mjs:114`](../../../scripts/prepare-windows-terminal-host.mjs)).

Verification covered the recovery contract with source assertions and included a live development startup:

```powershell
node scripts/prepare-windows-terminal-host.mjs
node --test scripts/prepare-windows-terminal-host.test.mjs scripts/dev.test.mjs
npm run dev
```

During this session, the final development run reported `app ready` and `window did-finish-load visible=true` while existing native host processes were observed.

## Why This Works

Windows can refuse replacement of a loaded executable or DLL even when the existing staged copy is valid for the process using it. Reusing only a locked, already-present target lets development continue to the staging completeness check without weakening missing-asset detection.

This is a development-continuity tradeoff: if the source binary changed while the old staged binary remained locked, the current run keeps the prior staged copy. A later run can refresh it after the owning process exits. Arbitrary copy failures are not hidden.

## Prevention

- Keep lock recovery narrow: require both an expected Windows lock error and an existing target.
- Preserve the complete-stage check so retaining one locked binary cannot mask unrelated missing runtime assets.
- Keep the regression assertion that verifies accepted error codes, the existing-target guard, and use of `refreshAsset` for the native host ([`prepare-windows-terminal-host.test.mjs:5`](../../../scripts/prepare-windows-terminal-host.test.mjs), [`prepare-windows-terminal-host.test.mjs:8`](../../../scripts/prepare-windows-terminal-host.test.mjs)).
- When process ownership changes, test both a cold start and a second start while a native session display remains alive.

## Related Issues

- [Missing matching OpenConsole makes the Windows Terminal host exit immediately](windows-terminal-missing-openconsole-causes-conpty-exit.md) explains why staging completeness must still be enforced.
- [Missing nested XBF resources causes TermControl CreateInstance2 failure](windows-terminal-missing-nested-xbf-causes-termcontrol-createinstance2-failure.md) covers the complementary requirement that nested runtime resources remain present.
