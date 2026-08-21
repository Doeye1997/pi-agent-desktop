# Standalone Agent Host

## Decision

Pi Desktop runs one independent Node Agent Host per canonical Electron `userData` directory. Electron Main is a reconnectable client. Renderer continues to use the trusted Main IPC bridge and never receives Host discovery credentials.

The Host owns active Agent turns, shell descendants, native session displays, session persistence, and non-Electron tools. Closing, crashing, or rebuilding Electron disconnects its client without terminating Host work. Development launches and supervises Host as a sibling of Electron so Windows process-tree termination cannot kill it during a rebuild.

## Connection contract

- Host listens on `127.0.0.1` at an operating-system-selected port.
- An atomically replaced private `runtime-registry.json` contains endpoint discovery, protocol/build versions, lease, session lifecycle, and owner identity. A separate private `runtime-generation` counter remains after clean shutdown so owner generations never reset.
- Owner identity is `generation + ownerToken + PID + processStartedAt`. PID alone never authorizes adoption, attach, or termination.
- The authenticated handshake repeats owner identity. Electron accepts a Host only when handshake and registry match.
- A lock file converges simultaneous starts on one Host per data directory. A live but unverifiable owner is `orphaned`; a replacement never guesses or kills it by PID.
- Client and Host protocol versions must match exactly. A mismatched Electron waits while the old Host finishes active work and exits.
- Renderer RPC MessagePorts are bridged over the authenticated Main-to-Host connection.
- Session display commands carry `requestId + generation`. The Host caches completion results, so reconnect retries are idempotent. ACK means native work completed, not merely queued.
- Host-to-Main requests wait up to 30 seconds for Electron reconnection, then fail with `ELECTRON_MAIN_UNAVAILABLE` and structured retry details.
- If Main disappears after accepting a request, Host does not replay the possibly side-effecting operation; it returns the same structured unavailable result after the wait window.

## Lifetime contract

- A connected Electron keeps Host alive.
- With no Electron and no owned runtime, Host may exit after the reconnect grace. A running or detached PI/display keeps Host alive. The short delay is only for explicit `replace-when-idle`. See `docs/decisions/2026-08-21-archive-kill-pi-keep-host.md`.
- Chat-channel connections do not keep Host alive.
- A Host build change requests replacement only when active work is idle; live work is not migrated.
- A Host crash is not replayed. Existing restart/reconnect signaling marks the interrupted UI state. An ambiguous surviving process is recorded as `orphaned` and is not adopted automatically.
- Update installation explicitly asks an idle Host to exit before replacing packaged files. Ordinary application quit only disconnects.

## Verification seam

The process integration test starts a real standalone fixture Host, rejects invalid authentication, identity, and protocol versions, holds work open, destroys client A, reconnects client B to the same verified owner, requests build replacement, completes the held work, and observes idle exit. Additional tests fence stale owners from overwriting/removing a newer registry, refuse ambiguous PID adoption, and prove idempotent session-display commands.

## Persistence choice

The registry remains atomic JSON with one logical writer. SQLite is deferred until runtime state needs relational queries, multi-record transactions, or multiple writers. Adding a database does not replace ownership, fencing, process identity, or completion ACKs.

Source specification: [pi-cockpit issue #5](https://github.com/Doeye1997/pi-cockpit/issues/5).
