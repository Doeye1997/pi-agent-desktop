# Standalone Agent Host

## Decision

Pi Desktop runs one independent Node Agent Host per canonical Electron `userData` directory. Electron Main is a reconnectable client. Renderer continues to use the trusted Main IPC bridge and never receives Host discovery credentials.

The Host owns active Agent turns, shell descendants, session persistence, and non-Electron tools. Closing or rebuilding Electron disconnects its client without terminating Host work. Development launches and supervises Host as a sibling of Electron so Windows process-tree termination cannot kill it during a rebuild.

## Connection contract

- Host listens on `127.0.0.1` at an operating-system-selected port.
- An atomically written private discovery record contains PID, port, protocol version, build version, and a random launch token.
- A lock file converges simultaneous starts on one Host per data directory and stale owners are recovered.
- Client and Host protocol versions must match exactly. A mismatched Electron waits while the old Host finishes active work and exits.
- Renderer RPC MessagePorts are bridged over the authenticated Main-to-Host connection.
- Host-to-Main requests wait up to 30 seconds for Electron reconnection, then fail with `ELECTRON_MAIN_UNAVAILABLE` and structured retry details.
- If Main disappears after accepting a request, Host does not replay the possibly side-effecting operation; it returns the same structured unavailable result after the wait window.

## Lifetime contract

- A connected Electron keeps Host alive.
- With no Electron and no running Agent task, Host exits after a short idle delay.
- Chat-channel connections do not keep Host alive.
- A Host build change requests replacement only when active work is idle; live work is not migrated.
- A Host crash is not replayed. Existing restart/reconnect signaling marks the interrupted UI state.
- Update installation explicitly asks an idle Host to exit before replacing packaged files. Ordinary application quit only disconnects.

## Verification seam

The process integration test starts a real standalone fixture Host, rejects invalid authentication and protocol versions, holds work open, destroys client A, reconnects client B to the same PID, requests build replacement, completes the held work, and observes idle exit. A second branch verifies structured Main-unavailable timeout behavior.

Source specification: [pi-cockpit issue #5](https://github.com/Doeye1997/pi-cockpit/issues/5).
