# Plan: Queue TUI — Live Progress Dashboard

> Source PRD: prd/006-queue-tui.md

## Architectural decisions

Durable decisions that apply across all phases:

- **Event callback**: `onEvent: (itemId: string, event: KnoxEvent) => void`
  added to `OrchestratorOptions`, mirroring the existing `onLine` callback
  pattern
- **New module**: `QueueTUI` — deep module owning all terminal rendering, with
  public interface: `constructor(items, options)`, `update(itemId, event)`,
  `appendLine(itemId, line)`, `start()`, `stop()`
- **CLI flags**: `--no-tui` boolean flag; TTY detection via
  `Deno.stdout.isTerminal()`
- **Output channels**: TUI renders to stderr (same as existing knox logs);
  stdout reserved for final JSON report
- **Render loop**: Single `setInterval` at 80ms; state mutations via callbacks,
  rendering reads current state (no races — single-threaded event loop)
- **State machine per item**:
  `pending → running (with sub-phases) → completed | failed | blocked | aborted`
- **Static fallback**: Same `update(itemId, event)` interface, prints
  timestamped log lines to stderr instead of ANSI table

---

## Phase 1: Event Pipeline + Static Fallback

**User stories**: 1, 12, 13, 17, 19

### What to build

Wire the `onEvent` callback through the orchestrator so that structured
lifecycle events (container created, loop start/end, check failed, nudge, bundle
extracted, aborted) flow from each engine run up to the CLI layer, tagged with
the item ID. Build a static fallback renderer that consumes these events and
prints human-readable timestamped log lines to stderr — one line per event,
prefixed with `[HH:MM:SS] [item-id]`. Add the `--no-tui` flag to the CLI
argument parser and detect TTY via `Deno.stdout.isTerminal()`. When TUI is
inactive (non-TTY or `--no-tui`), use the static fallback. When `--verbose` is
also set in static mode, forward `onLine` output as prefixed lines (preserving
current behavior). Per-item log file capture continues unchanged regardless of
mode.

### Acceptance criteria

- [ ] `OrchestratorOptions` accepts an `onEvent` callback
- [ ] Orchestrator calls `onEvent(itemId, event)` for every `KnoxEvent` emitted
      by each engine run
- [ ] Orchestrator tests verify `onEvent` is called with correct
      `(itemId, event)` pairs, following existing `onLine` test patterns
- [ ] Static fallback renderer maps event sequences to formatted
      `[HH:MM:SS] [item-id] <description>` lines on stderr
- [ ] Static fallback renderer has snapshot-style string tests
- [ ] `--no-tui` flag is parsed and respected
- [ ] Non-TTY environments automatically use static fallback
- [ ] `--verbose` in static mode forwards agent output lines with item ID prefix

---

## Phase 2: Live Status Table

**User stories**: 1, 2, 3, 4, 5, 6, 7, 8, 9, 18

### What to build

The core QueueTUI module that renders a live-updating ANSI table to stderr. The
table shows one row per queue item with: a status icon (braille spinner for
running, `✓` for completed, `✗` for failed, `⚠` for aborted, `○` for blocked,
`·` for pending), the item ID, current loop count (e.g., "loop 2/5"), current
phase text mapped from `KnoxEvent` types, and elapsed time. A header line shows
the queue name, total wall time, and aggregate counts (N running, N done, N
failed, N pending). Completed items show their result branch name. Failed items
show a brief inline error reason. Blocked items show what they're blocked by.
Color coding: green for completed, red for failed, yellow for running/aborted,
dim for pending/blocked. The braille spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) cycles at 80ms via
the render interval. Extract the event-to-display-state mapping as a pure
function for unit testing. Wire the QueueTUI into the CLI when TUI is active
(TTY and no `--no-tui`).

### Acceptance criteria

- [ ] QueueTUI renders a table to stderr with one row per item showing icon, ID,
      loop, phase, and elapsed time
- [ ] Header shows queue name, total elapsed time, and aggregate status counts
- [ ] Braille spinner animates at 80ms for running items
- [ ] Status icons and colors match the specification (green/red/yellow/dim)
- [ ] Phase text updates correctly for each `KnoxEvent` type
- [ ] Completed items display their result branch name
- [ ] Failed items display a brief inline error reason
- [ ] Blocked items display the ID of the item blocking them
- [ ] State machine pure function has unit tests covering all event sequences
      and status transitions
- [ ] CLI creates and wires QueueTUI when TTY is detected and `--no-tui` is not
      set

---

## Phase 3: Verbose Log Panel

**User stories**: 10, 11

### What to build

A scrolling log panel that appears below the status table when `--verbose` is
passed in TUI mode. The panel shows live agent output lines from running items,
received via `appendLine(itemId, line)`. Each line is prefixed with the item ID
in a color assigned from a cycling palette (cyan, magenta, yellow, blue, green).
The log buffer is sized to fit the remaining terminal height (terminal rows
minus table rows minus separator), keeping only the most recent lines. A
horizontal separator line (`─`) divides the table from the log panel. When
concurrency is 1, lines from the single running item are shown without prefix.
When concurrency > 1, prefixes and colors distinguish interleaved output.

### Acceptance criteria

- [ ] `--verbose` in TUI mode shows a log panel below the status table separated
      by a horizontal rule
- [ ] Agent output lines appear in the log panel with item ID prefix
- [ ] Item ID prefixes are color-coded with a cycling palette
- [ ] Log buffer is sized to remaining terminal height and shows only the most
      recent lines
- [ ] With concurrency 1, log lines from the single running item display cleanly
- [ ] With concurrency > 1, interleaved output is visually distinguishable by
      color

---

## Phase 4: Lifecycle Polish

**User stories**: 14, 15, 16, 20

### What to build

Handle end-of-life and edge-case scenarios for the TUI. On Ctrl+C: update all
running items to aborted status, perform one final render showing the aborted
state, freeze the frame in place (stop clearing/redrawing), and print the
summary below. On normal finish: freeze the last frame in the terminal and print
the summary below it, so scrollback contains both the final table state and the
summary. On terminal resize (`SIGWINCH`): recalculate layout dimensions (table
width, log panel height) and re-render on the next tick without visual
corruption. For large queues (20+ items): if the table exceeds terminal height,
truncate visible rows with a "… and N more" indicator, prioritizing running and
failed items over pending/completed ones.

### Acceptance criteria

- [ ] Ctrl+C updates running items to "aborted," renders one final frame,
      freezes display, and prints summary below
- [ ] Normal queue completion freezes the last frame and prints summary below it
- [ ] Terminal resize recalculates layout and re-renders cleanly
- [ ] Queues with 20+ items remain usable — table truncates with indicator when
      exceeding terminal height
- [ ] Running and failed items are prioritized over pending/completed when
      truncating
- [ ] Scrollback after completion contains both the frozen final table and the
      printed summary
