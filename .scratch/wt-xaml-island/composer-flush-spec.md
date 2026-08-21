# Windows Terminal composer flush + pane alignment

Status: ready-for-agent

## Problem Statement

The live Pi pane is already a Windows Terminal TermControl inside the cockpit. Two things are still wrong from the user's seat.

The native child is slightly off the Electron hole, so cells and the input bar do not sit where the pane is.

The input bar looks like a floating card on top of the TUI. Usage is missing under the field. The user does not want a hover card. They want a Linear-style compose box: taller single-line field, chip row under it, flush to the pane edges, still covering the TUI editor so they type in a real box. Working must stay visible above that bar.

HLSL / AtlasEngine only paints cells. It does not replace the composer. Electron HTML still cannot cover the TermControl HWND.

## Solution

Keep TermControl drawing Pi. Keep the composer as XAML in the same island, covering the TUI editor.

Stop the floating card: no side/bottom margin, no rounded outer card. The bar is flush to the pane. Taller single-line field. Enter sends. No send button. Under the field, one wrapping chip row: folder, worktree, usage, model, thinking, MCP. Usage must stay visible (wrap, never clip away). Prefer fork usage chips (SuperGrok / usage statuses); if none, show context tokens.

Parent the native host to Electron's Chromium content HWND so CSS hole bounds line up with the GPU surface.

Do not rewrite the Electron shell in this cut. Linear look is XAML now; a React Linear library waits for a later Electron-shell swap.

## User Stories

1. As a cockpit user, I want the GPU terminal to sit exactly in the session pane hole, so that cells are not shifted relative to the sidebar and file chrome.
2. As a cockpit user, I want that alignment to survive resize, DPI change, and window move, so that the surface does not drift after I drag or snap the window.
3. As a cockpit user, I want the input bar flush to the bottom and sides of the pane, so that it does not look like a floating card.
4. As a cockpit user, I want no rounded outer card and no empty gutter around the bar, so that the compose box reads as part of the pane.
5. As a cockpit user, I want a taller single-line message field, so that the bar feels like a Linear compose box rather than a 40px Fluent chip.
6. As a cockpit user, I want Enter to send the finished line to Pi, so that submit matches today's Pi habit.
7. As a cockpit user, I do not want a send button, so that the field stays clean.
8. As a cockpit user, I want the TUI character editor covered by that field, so that I type in a real box with IME, not into glyphs.
9. As a cockpit user, I want Chinese IME candidates on the XAML field, so that Pinyin still works.
10. As a cockpit user, I want focusing the field to take keys away from TermControl, so that characters do not double-enter the TUI editor.
11. As a cockpit user, I want clicking cells to select/copy logs, so that the GPU surface is not dead glass.
12. As a cockpit user, I want folder, worktree, usage, model, thinking, and MCP on one chip row under the field, so that dock facts stay on the bar.
13. As a cockpit user, I want that row to wrap when the pane is narrow, so that usage is not squeezed off the right edge.
14. As a cockpit user, I want usage under the field even when SuperGrok/usage chips exist, so that 用量 is a first-class chip, not a missing label.
15. As a cockpit user, I want usage to fall back to context tokens when no usage chip exists, so that a normal session still shows Context 3.5k rather than a blank.
16. As a cockpit user, I want MCP to remain a separate chip from usage, so that servers and token/quota facts are not merged into one string.
17. As a cockpit user, I want cwd and worktree to stay pickers on that row, so that I can relocate without a second path.
18. As a cockpit user, I want model and thinking to stay pickers on that row, so that `/model` and thinking cycles still work.
19. As a cockpit user, I want `/` skill pick to keep working from the field, so that the display swap does not rip skills.
20. As a cockpit user, I want Working / Thinking above the bar to stay visible, so that a live turn is not hidden by a taller compose box.
21. As a cockpit user, I want the bar height capped so it covers the TUI editor/path/usage/MCP band only, so that transcript rows are not eaten.
22. As a cockpit user, I want the bar opaque, so that TUI glyphs do not show through the field or chips.
23. As a cockpit user, I want light/dark to retint the flush bar, so that it matches the cockpit theme with a Linear gray surface, not a Fluent acrylic card.
24. As a cockpit user, I want one live TermControl for the selected session, so that background sessions do not open extra windows.
25. As a cockpit user, I want switching sessions to keep the same flush composer layout, so that every conversation looks like one product.
26. As a cockpit user, I want a dead Pi to show the existing dead surface, so that a crash is not a frozen composer pretending to live.
27. As a cockpit user, I want relocating cwd to remount TermControl and keep this composer, so that folder change does not resurrect the floating card.
28. As a future agent, I want no second session-display policy module, so that start/focus/write/resize/bounds/dock/dead stay one port.
29. As a future agent, I want HLSL left inside AtlasEngine, so that shaders are not used to fake buttons or IME.
30. As a future agent, I want Electron HTML kept off the TermControl HWND, so that we do not reintroduce a web overlay.
31. As a future agent, I want this XAML bar to be the throwaway-or-keep visual for a later React Electron shell, so that a Linear component library is not bolted into the island now.
32. As a cockpit user, I want the project tree and session list to stay Electron HTML beside the island, so that this cut does not rewrite the shell.
33. As a developer, I want a missing or misaligned host to fail loudly, so that we do not silently fall back to xterm.
34. As a developer, I want tests to fake the session-display port, so that spawn/dock/bounds stay node:test.
35. As a cockpit user, I want wheel over cells to still reach Pi, so that history scroll is not stolen by the flush bar.
36. As a cockpit user, I want pointer events on chips to stay on chips, so that a click on usage/model does not hit glyphs underneath.
37. As a cockpit user, I want paste into the focused field to reach Pi on Enter, so that clipboard compose still works.
38. As a cockpit user, I want copy of a TermControl selection to keep working, so that I can paste logs out.
39. As a Windows user, I want this to run on the same host the app already ships, so that I do not install a second Terminal app.
40. As a cockpit user, I want minimizing and restoring the app to keep hole alignment, so that I do not get a shifted surface after taskbar restore.
41. As a cockpit user, I want the composer not to reserve layout height in Electron, so that the PTY is not pushed up and double-clipped.
42. As a cockpit user, I want no second external `wt.exe` window, so that cockpit stays one desktop frame.

## Implementation Decisions

- One seam: the existing session-display port (start, focus, write, resize, bounds, dock, hide, dead, kill). Do not add a second policy module. Composer look and HWND parenting are behind that port, in the Windows Terminal XAML host.
- TermControl still owns the Pi connection. Composer Enter still writes one finished line plus CR on that connection. No per-keystroke forwarding.
- Composer stays XAML in the same island as TermControl. Electron HTML must not cover the HWND.
- Cover, do not clip: the PTY stays full-pane. The flush bar covers the TUI editor band. Do not resize the PTY to chase bar height. Do not clip extra TUI rows to hide Working.
- Flush geometry: outer composer surface margin 0, corner radius 0, full width, bottom aligned. Top hairline only. Inner padding allowed. No floating 12px gutter. No inner rounded capsule around the chip row.
- Compose layout: taller single-line field (about 52px), then one wrapping chip row. Enter sends. No send button. No Ctrl+Enter. No multiline.
- Chip row order: folder, worktree, usage, model, thinking, MCP. Wrap when the pane is narrow. Usage must remain in the wrapped set, not overflow-hidden.
- Usage label: if fork usage chips exist (key/text matching grok/usage), join those texts. Else last assistant message token sum as `Context {n}`. Else `Usage —`. MCP stays its own chip.
- Dock facts still come from session/app state via the existing dock payload. Do not parse terminal cells.
- Working stays visible above the bar. Bar height must not grow into a Linear mega-composer that eats the status line. Idle blank vs Working remains the old TUI rule; this cut does not reintroduce per-frame character-scan clipping.
- Native child parenting: attach the session host to Electron's Chromium content HWND (`Chrome_RenderWidgetHostHWND`, fallback `Chrome_WidgetWin_1`), not the outer BrowserWindow frame. Bounds are CSS hole rect × scaleFactor in that content HWND's client space.
- Theme: Linear-ish gray bar on the existing light/dark switch. Do not introduce Fluent UI React into the island. Do not add a React component library in this cut.
- Later Electron-shell swap may restyle chrome with a Linear-ish React kit. That is a later cut. This bar is XAML until then.
- HLSL stays optional/off for cell post-process. It is not a compositor for the composer.
- Host still fails loud if the island or TermControl cannot start. No xterm, WezTerm, or `wt.exe` fallback.
- Overlay law unchanged: fork extras stay in fork layers; this cut only changes the session-display host and dock projection.

## Testing Decisions

- Good tests check external behavior of the existing session-display seam: dock projection (usage chip vs context fallback), bounds still forwarded, composer still submits one line plus CR, native host still covers TermControl with a bottom bar that is flush (no floating margin/radius). They do not assert GPU pixels, HLSL, or Win32 EnumChildWindows success at runtime.
- Do not add a Windows Terminal e2e or screenshot suite.
- Modules: session-display manager (already faked), dock state builder, native host source-scan tests (same style as the current host tests that read the C++ source for composer/IME/clipboard contracts).
- Prior art: session-display contract tests, session-display-dock tests, windows-terminal-host source-scan tests, EmbeddedPiTerminal tests that forbid HTML overlay on the HWND.
- One seam. Do not add a second policy test module.

## Out of Scope

- Replacing the Electron shell with React, or picking a Linear React component library.
- Drawing the composer or chips in HLSL / AtlasEngine pixel shaders.
- HTML overlay on the TermControl HWND.
- Stacking the composer as an Electron sibling under a shorter terminal hole (user rejected; cover-on-terminal stays).
- Multiline compose, Ctrl+Enter send, or a send button.
- Covering the Working / Thinking status line.
- WezTerm, Ghostty, from-scratch wgpu, or an external `wt.exe` window.
- Changing Pi session files, archive, relocate rules, or channel inbound.
- Silent xterm fallback.
- Per-keystroke forwarding into the TUI editor.
- Cropping the PTY to hide dock rows.

## Further Notes

Follow-on to `.scratch/wt-xaml-island/spec.md`. That spec still owns TermControl-in-island, no HTML overlay, no WezTerm. This spec only changes composer chrome (flush Linear compose box) and native hole alignment.

Updates `docs/decisions/2026-08-18-tui-input-chrome.md` visually: still a GUI composer covering the TUI editor; the sheet is no longer a floating / clipped HTML card. Input ownership, chip contents, and “do not cover Working” stay.

Seam check: one session-display port; XAML host implements flush composer + Chromium content HWND parenting. If that is the wrong cut, say so before more implementation.
