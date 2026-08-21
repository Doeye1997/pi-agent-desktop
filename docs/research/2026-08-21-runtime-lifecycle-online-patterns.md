# Runtime lifecycle: online architecture patterns

Date: 2026-08-21

## Question

How should Pi Desktop keep PI sessions alive across Electron rebuild, crash,
upgrade, and window closure without duplicate ownership or PID-based mistakes?

## Primary-source findings

### 1. Durable work must not be owned by Electron

Electron `utilityProcess` is explicitly a child process launched by Electron
Main. It is useful for isolated work, but it is the wrong ownership boundary for
work required to survive replacement of Electron Main.

Node's documented Windows pattern supports the required boundary: spawn with
`detached: true`, disconnect stdio from the parent, then call `unref()`. This lets
the child continue after its parent exits.

Sources:

- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)
- [Node.js child_process: detached and unref](https://nodejs.org/api/child_process.html#optionsdetached)

Implication: keep standalone Agent Host. Electron Main is a reconnectable client,
not runtime owner. Do not replace Agent Host with `utilityProcess` or move PI
ownership back into Main.

### 2. Quit is a protocol barrier, not a notification

Electron documents that `before-quit` can be synchronously blocked with
`event.preventDefault()`. It also documents an important Windows exception:
`before-quit` and `will-quit` are not emitted for system shutdown, restart, or
logout.

Source: [Electron app lifecycle](https://www.electronjs.org/docs/latest/api/app)

Implication:

1. Ordinary quit/rebuild: block quit, request display detach, wait for a
   completion ACK with a deadline, then allow quit.
2. Crash/system shutdown: correctness cannot depend on Electron cleanup. Agent
   Host/native host must detect client loss and converge independently.
3. ACK means native detach completed, not merely "message queued".

### 3. PID is an observation, not an identity

Windows documents process identifiers as valid only from process creation until
termination. `GetProcessTimes` exposes the process creation timestamp.

Sources:

- [CreateProcess: process identifier lifetime](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessa)
- [GetProcessTimes: process creation time](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)

Implication: registry identity should be:

```text
sessionId + generation + ownerToken + pid + processCreationTime
```

Recovery must open the PID, verify creation time, then handshake with the Agent
Host using `ownerToken` and `generation`. PID alone must never authorize attach,
adopt, or kill.

No executable hash is proposed: it adds cost without resolving a live identity
ambiguity in this local cooperative threat model.

### 4. Lease plus fencing prevents two owners

Kubernetes uses Lease objects for heartbeats and leader election. Its model
includes `holderIdentity`, `acquireTime`, `renewTime`, `leaseDurationSeconds`, and
`leaseTransitions`; takeover happens only after expiry and uses optimistic
concurrency.

Sources:

- [Kubernetes Leases](https://kubernetes.io/docs/concepts/architecture/leases/)
- [Lease v1 fields](https://kubernetes.io/docs/reference/kubernetes-api/coordination/lease-v1/)

Adaptation for one desktop machine:

```text
holderIdentity -> ownerToken
leaseTransitions -> generation
renewTime + leaseDurationSeconds -> renewedAt + expiresAt
resourceVersion -> atomic compare/replace of registry generation
```

The lease decides who may mutate runtime state. The process-identity handshake
decides whether an existing process is the expected runtime. Both are required;
neither replaces the other.

### 5. Every control request needs a deadline and retry identity

gRPC's official guidance says clients should set explicit deadlines; retry is
safe only under defined conditions because a failed response does not always
mean server logic did not run.

Sources:

- [gRPC deadlines](https://grpc.io/docs/guides/deadlines/)
- [gRPC retry](https://grpc.io/docs/guides/retry/)

Implication: `attach`, `detach`, `stop`, and `adopt` carry `requestId` plus
`generation`. Retrying the same request replays its stored result or performs an
idempotent no-op. A timed-out request must not be retried as a new operation with
a new identity.

### 6. SQLite is valid later, not necessary for this registry

SQLite is designed for local application storage and provides atomic
transactions, including crash recovery. It becomes valuable when lifecycle
state grows into multiple related records, history, queries, or concurrent
writes.

Sources:

- [Appropriate uses for SQLite](https://www.sqlite.org/whentouse.html)
- [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html)

Current need is one small authoritative runtime record with one logical writer.
An atomically replaced JSON registry is the smaller solution. Adding SQLite now
would not fix ownership, fencing, ACK semantics, or Windows process identity.

## Recommended architecture

```text
Electron Renderer
  -> Electron Main (replaceable client)
    -> authenticated IPC
      -> Agent Host (durable owner + lifecycle state machine)
        -> native display host
        -> PI process tree

runtime-registry.json
  = discovery + generation + lease + verified process identity

runtime-generation
  = durable monotonic fencing counter retained across clean shutdown
```

Agent Host owns one state machine per session:

```text
starting -> running-detached <-> running-attached -> stopping -> exited
                         \-> orphaned (identity or handshake mismatch)
```

UI visibility, HWND validity, and Electron connection status are observations;
none of them imply PI death.

## Decision

Keep standalone Agent Host, atomic JSON registry, completion ACKs, and explicit
process identity. Add lease/fencing semantics. Do not add Windows Service,
Electron `utilityProcess`, executable hashing, or SQLite in this iteration.

## Decision alignment

`docs/decisions/2026-08-20-standalone-agent-host.md` now distinguishes an idle
Host from an owned PI/display runtime. Electron exit may end an empty Host after
the reconnect grace; it never terminates an owned PI/display runtime.
