---
title: Missing nested XBF resources make TermControl creation fail
date: 2026-08-20
category: runtime-errors
module: Windows Terminal XAML host
problem_type: runtime_error
component: tooling
symptoms:
  - "TermControl.CreateInstance2 fails with HRESULT 0x802B000A"
  - "A known-good host works from one staging directory while a rebuilt host fails from another"
  - "Top-level runtime hashes match even though the XAML resource layout is incomplete"
root_cause: incomplete_setup
resolution_type: environment_setup
severity: high
tags:
  - windows-terminal
  - xaml-island
  - termcontrol
  - xbf
  - native-runtime
  - staging
  - createinstance2
---

# Missing nested XBF resources make TermControl creation fail

## Problem

The unpackaged Windows Terminal XAML host reached `TermControl.CreateInstance2`, then failed with HRESULT `0x802B000A`. The native binary and top-level DLL/XBF files appeared to match a known-good staging directory, which initially made the rebuilt host look faulty.

The comparison was incomplete. The working runtime also contained these path-qualified resources:

```text
Microsoft.Terminal.Control/TermControl.xbf
Microsoft.Terminal.Control/SearchBoxControl.xbf
```

The failing staging directory contained only the top-level XBF copies. `TermControl` resource lookup depends on both the files and their relative paths.

## Symptoms

- `TermControl.CreateInstance2` throws before the terminal connection starts.
- The same host can work from a complete staging directory and fail from a copied or partially refreshed directory.
- Hashing only top-level files reports no meaningful difference.
- Rebuilding or relinking the host does not change the failure.

## What Did Not Work

- Comparing only top-level runtime asset hashes. This omitted the nested resource directory and produced a false equivalence between stages.
- Treating the failure as a C++ source, factory GUID, dispatcher, or HWND-mount regression before validating the complete runtime tree.
- Recopying only DLLs and root-level XBF files. The resource-qualified paths remained absent.

## Solution

Treat the staging layout as a recursive manifest, not a flat DLL list.

The staging script includes both root-level and nested XBF targets in its completeness check:

```js
"TermControl.xbf",
"SearchBoxControl.xbf",
"Microsoft.Terminal.Control/TermControl.xbf",
"Microsoft.Terminal.Control/SearchBoxControl.xbf",
```

It sources the nested resources from the matching Windows Terminal build and preserves their relative target names. Its copy helper creates parent directories recursively before copying.

Relevant implementation:

- [`scripts/prepare-windows-terminal-host.mjs`](../../../scripts/prepare-windows-terminal-host.mjs) defines the complete asset manifest, copies the nested XBF files, and creates nested target directories.
- [`pi-session-display-host.cpp`](../../../native/wt-xaml-island/pi-session-display-host.cpp) reports the failure at the `CreateInstance2` boundary.
- [`windows-terminal-host.test.mjs`](../../../src/main/fork/windows-terminal-host.test.mjs) guards the two nested resource paths.

After restoring the nested directory, the native HWND smoke passed the `CreateInstance2` boundary, emitted connection-state transitions and process-start, and exited cleanly after disposal.

## Why This Works

`Microsoft.Terminal.Control.dll` creates controls backed by compiled XAML resources. In an unpackaged side-by-side deployment, file presence alone is insufficient: the runtime resolves those resources using the expected relative layout.

This failure occurs before the pseudoterminal process starts. That distinguishes it from a second staging invariant: `OpenConsole.exe` must also come from the same Windows Terminal build as `TerminalConnection.dll`. Missing nested XBF files cause control creation to fail; a missing or mismatched console server causes a later connection or child-process failure.

## Prevention

- Compare staging trees by relative path and hash, recursively.
- Keep nested resources in the same manifest used to decide whether staging is already complete.
- Copy all Windows Terminal native assets from one matching build.
- Preserve a source-level contract test for required nested targets.
- Use a real native HWND smoke that must pass control creation, connection state, and process start. A build-only check cannot detect runtime resource-layout failures.

## Related Specification

The XAML Island host is intentionally a hard-failure path with no HTML or alternate terminal fallback. See the [Windows Terminal XAML Island specification](../../../.scratch/wt-xaml-island/spec.md).
