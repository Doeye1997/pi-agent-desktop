# Sidebar running indicator — 2026-08-19

Decisions from the spinner grill. Not a spec.

## Decision: what the spinner means

- **Chosen:** Official agent-turn state. Same set Chat already uses: `runningSessionIds`.
- **Why:** Sidebar should mean “this turn is live,” not “the PTY exists” and not “the screen has the word Thinking.”
- **Rejected:** Scan TUI pixels for `Working` / `Thinking` / spinner. Use live-PTY mark as the spinner.

## Decision: how Cockpit reports that state

- **Chosen:** Desktop-owned Pi extension injected with `--extension`. Listens `agent_start` / `agent_settled` (and mid-run `session_start` if not idle). Writes an OSC mark on stdout. Main strips it and posts `cockpit-running` into the host, which unions into `runningSessionIds`.
- **Why:** Cockpit is a separate `pi` PTY, so it never entered the RPC registry. Extension events are the same idle/working signal Herdr already uses. OSC stays on the existing PTY pipe — no extra server.
- **Rejected:** Keep screen scrape as the long-term source. Leave Cockpit rows without a spinner. Reuse the Herdr socket. Put the reporter in the global skills-repo extension folder.

## Decision: hidden `Thinking...` labels

- **Chosen:** Not a live turn. `hideThinkingBlock` leaves `Thinking...` in the transcript after the turn ends.
- **Why:** Matching that word on the whole viewport made the sidebar spin forever.
- **Rejected:** Treat any `Thinking` text as working.

## Decision: ship shape

- **Chosen:** Land official reporting on `fix/sidebar-tui-working` / PR #28. Remove the screen-scrape path in the same branch.
- **Why:** One PR should not teach reviewers that Thinking scans are the contract, then reverse it later.
- **Rejected:** Merge the Thinking-label hotfix alone and do the official channel later. Keep scrape as a fallback beside the official set.
