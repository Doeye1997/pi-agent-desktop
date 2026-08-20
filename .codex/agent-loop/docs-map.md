# Docs map (living)

## Read order

1. README / package scripts
2. This pack for agent loop / release / smoke
3. `docs/` only when a surface routes here

## Authority

| Topic                          | Owner                                                                                      | Do not treat as truth |
| ------------------------------ | ------------------------------------------------------------------------------------------ | --------------------- |
| Agent verify / release env     | `.codex/agent-loop/*`                                                                      | agent memory          |
| Pi runtime/config locations    | `F:/Project/claude/skills/config/pi/README.md`                                             | `F:/PiData`           |
| Desktop IPC / host lifecycle   | `src/main/`, `src/agent-host/`                                                             | chat recap            |
| Standalone Agent Host lifetime | `docs/decisions/2026-08-20-standalone-agent-host.md`                                       | chat recap            |
| Hang / abort decisions         | `docs/decisions/2026-08-17-session-hang.md`                                                | this chat             |
| Session relocate decisions     | `docs/decisions/2026-08-18-session-relocate.md`                                            | this chat             |
| TUI input chrome / UI kit      | `docs/decisions/2026-08-18-tui-input-chrome.md`                                            | this chat             |
| Idle TUI blank bottom row      | `docs/solutions/ui-bugs/idle-tui-bottom-blank-row.md`                                      | this chat             |
| Windows Terminal runtime exit  | `docs/solutions/runtime-errors/windows-terminal-missing-openconsole-causes-conpty-exit.md` | this chat             |
| Private main vs origin/main    | `docs/solutions/workflow-issues/private-main-vs-origin-main-checkout.md`                   | this chat             |

## Drift debt

- (2026-08-20) Pi runtime moved from `F:/PiData` to the skills repo `.runtime/pi`; authoritative launcher and docs live in `config/pi/`.
