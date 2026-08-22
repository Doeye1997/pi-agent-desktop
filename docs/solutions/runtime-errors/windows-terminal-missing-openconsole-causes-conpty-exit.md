---
title: Missing matching OpenConsole makes the Windows Terminal host exit immediately
date: 2026-08-20
last_updated: 2026-08-20
category: runtime-errors
module: Windows Terminal XAML host
problem_type: runtime_error
component: tooling
symptoms:
  - Windows Terminal XAML host reports Connected and then marks the Pi session dead almost immediately
  - Pi exits with status 3221225786 (0xC000013A) shortly after process start
  - Pressing Enter appears ineffective or the restarted terminal closes again
root_cause: incomplete_setup
resolution_type: code_fix
severity: high
tags: [windows-terminal, xaml-island, conpty, openconsole, native-runtime]
---

# Missing matching OpenConsole makes the Windows Terminal host exit immediately

## Problem

In this incident, the native XAML Island host could load `TerminalConnection.dll`, create a `ConptyConnection`, and briefly report `Connected`, but the Pi child process exited almost at once. The pre-fix staged Windows Terminal runtime was incomplete: it omitted the `OpenConsole.exe` built beside the staged terminal DLLs.

## Symptoms

- Host diagnostics progressed through `Connecting` and `Connected`, then logged `process-exit ... code=3221225786` and `Failed` roughly one event cycle later.
- The native host itself remained available long enough to report the dead session, so the failure looked like a Pi command, Enter-key, or restart bug.
- Launching the same Pi command in an independent ConPTY stayed alive, ruling out the Pi executable, arguments, working directory, and session file as the primary cause.

## What Didn't Work

- Debugging only the Pi command line did not explain why the identical command survived outside the XAML host.
- Staging `TerminalConnection.dll` and its dependency DLLs without `OpenConsole.exe` was not a complete Windows Terminal runtime. DLL loading success did not prove that the console-server process came from the same build.
- Removing a session as soon as it became dead prevented `TermControl` from forwarding Enter to its native restart path.
- Calling `FreeLibrary` on the manually loaded Terminal Control, Terminal Connection, and WinUI XAML modules during host teardown caused a later access violation because process-global WinRT/XAML objects still referenced them.

## Solution

Treat `TerminalConnection.dll` and `OpenConsole.exe` as a matched staging unit.

The preparation script now includes `OpenConsole.exe` in the completeness check ([`prepare-windows-terminal-host.mjs:68`](../../../scripts/prepare-windows-terminal-host.mjs)) and copies it from the same Windows Terminal build root as the terminal DLLs ([`prepare-windows-terminal-host.mjs:173`](../../../scripts/prepare-windows-terminal-host.mjs)). A staging directory missing either file is rebuilt instead of being accepted as complete.

The native host also uses one generated session GUID for both control settings and connection initialization ([`pi-session-display-host.cpp:1271`](../../../native/wt-xaml-island/pi-session-display-host.cpp), [`pi-session-display-host.cpp:1276`](../../../native/wt-xaml-island/pi-session-display-host.cpp)). When the connection closes, it marks the mounted display dead without deleting the native session, allowing a `RestartTerminalRequested` event to reconnect it ([`pi-session-display-host.cpp:1712`](../../../native/wt-xaml-island/pi-session-display-host.cpp), [`pi-session-display-host.cpp:1440`](../../../native/wt-xaml-island/pi-session-display-host.cpp)). The TypeScript manager preserves that mount on a dead mark and continues forwarding input; its regression test sends Enter after the dead mark ([`session-display.test.mjs:231`](../../../src/agent-host/fork/session-display.test.mjs)).

Finally, the host releases its own references but keeps the manually loaded WinRT/XAML modules loaded for the process lifetime, leaving final unload ordering to the Windows loader ([`pi-session-display-host.cpp:404`](../../../native/wt-xaml-island/pi-session-display-host.cpp), [`pi-session-display-host.cpp:1210`](../../../native/wt-xaml-island/pi-session-display-host.cpp)).

## Why This Works

The incident isolated the staged runtime pair as the cause: the exact Pi command stayed alive in an independent ConPTY, while adding the matching `OpenConsole.exe` changed the native host from an immediate child exit to a stable connection. The current staging script encodes that result as an invariant by sourcing `TerminalConnection.dll` and `OpenConsole.exe` from one Windows Terminal build root.

The session GUID, restart retention, and DLL lifetime changes close adjacent lifecycle gaps exposed after the runtime pair was corrected: the control and connection identify the same session, the restart event can reconnect an exited child in place, and teardown cannot unload code while process-global XAML objects may still reference it.

## Prevention

- Stage Windows Terminal native assets as a version-matched set; never copy `TerminalConnection.dll` alone.
- Keep `OpenConsole.exe` in both the copy manifest and the staging-completeness predicate. The regression test enforces both requirements ([`windows-terminal-host.test.mjs:29`](../../../src/agent-host/fork/windows-terminal-host.test.mjs)).
- Keep `TermControl` as the sole owner of the Pi child and ConPTY. A node-pty byte bridge would reintroduce the double-PTY failure mode already retired by the session-display decision ([`learnings.md`](../../../.codex/agent-loop/learnings.md)).
- Diagnose native terminal failures by logging connection transitions, child PID, and exit code. Derive elapsed time from timestamped host logs when needed. A brief `Connected` state does not prove the child is healthy.
- Before changing Pi arguments, run the exact command in an independent ConPTY. If it stays alive there, compare the host's staged native runtime first.
- Do not manually unload WinRT/XAML modules that may own process-global state; keep them loaded until process exit.

During incident verification, the off-screen native smoke held Pi in `Connected` state for three seconds and the disposed host exited with code 0. The focused Node test command also passed:

```powershell
node --test src/agent-host/fork/session-display.test.mjs src/main/ipc-trust.test.mjs src/renderer/components/EmbeddedPiTerminal.test.mjs src/renderer/fork/session-tui-select.test.mjs src/agent-host/fork/windows-terminal-host.test.mjs
```

## Related Issues

- [Windows Terminal XAML island display spec](../../../.scratch/wt-xaml-island/spec.md) defines the no-fallback native display contract that made this a hard runtime failure rather than an xterm fallback.
- [Locked Windows Terminal host asset blocks development startup](locked-windows-terminal-host-asset-blocks-dev-startup.md) covers the distinct complete-stage case where a surviving Agent Host prevents an in-place binary refresh.
- No existing `docs/solutions` entry covered the missing matched console-server asset as of 2026-08-20.
