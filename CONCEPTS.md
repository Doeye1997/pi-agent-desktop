# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Desktop Runtime

### Agent Host

The independent long-lived runtime that owns active Agent work and native session displays while desktop clients disconnect and reconnect.

An Agent Host survives ordinary Electron replacement while work remains live; replacement of the Host itself waits for owned work to become idle.

### Electron Main

The reconnectable desktop client that owns trusted UI integration and forwards renderer requests to the Agent Host without owning active Agent work.

### Native Session Display

The Windows Terminal-based terminal surface for a Pi session, owned beyond an individual Electron window so it can detach, remain live, and attach to a replacement window.

## Relationships

- Electron Main connects renderers to one Agent Host for the desktop profile.
- The Agent Host owns Native Session Displays; Electron Main supplies the current window attachment point.
