# Archive kills PI; Host stays — 2026-08-21

Decisions from the archive/memory grill. Not a spec.

## Decision: what archive does to PI

- **Chosen:** Archive is cold. Kill that session's TUI PI immediately. Drop that RPC wrapper. File stays (`desktop.archived`). Clicking an archived row does not spawn. Unarchive only puts the row back; select from the live list starts PI.
- **Why:** Archived work must free RAM. Hide-only left background `pi` running.
- **Rejected:** Kill now, spawn again if you open the archived row. Kill now and leave the archived row selected with a blank pane.

## Decision: archiving the tab you are looking at

- **Chosen:** Kill PI. Select the newest remaining live session. None → empty pane. Archived row does not stay selected.
- **Why:** Cold archive must not leave a dead TUI as the current tab.
- **Rejected:** Stay on the archived row with a blank pane. Block archive of the current tab.

## Decision: archive while a turn is running

- **Chosen:** Kill anyway. No extra prompt.
- **Why:** Archive means this conversation is done. Matches close-PI + free RAM. Delete still blocks while running; archive does not.
- **Rejected:** Block until Stop (same as delete). Confirm dialog then kill.

## Decision: Host lifetime vs killing PI

- **Chosen:** Archive never exits Agent Host. A connected Electron keeps Host alive. Electron disconnect without `replace-when-idle` uses the 30s startup grace, not 250ms. Only an explicit version replacement exits after the short idle delay.
- **Why:** 250ms idle-exit after the first client made Host die on Electron rebuilds and after the last PI died. Closing one session's PI is not Host shutdown.
- **Rejected:** Keep 250ms post-client idle exit. Treat last-PI-killed as Host idle-exit. Dispose Host resources from `sessions.setArchived`.
