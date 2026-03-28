# PRD 006: Queue TUI — Live Progress Dashboard

## Problem Statement

When running a queue of tasks via `knox queue`, the user has no visibility into
what the containers and Claude instances are doing. The terminal is silent apart
from Knox's own log messages (`[knox:INFO]`), giving no indication of progress,
current phase, or whether things are stuck. Agent output is captured to per-item
log files on disk but never displayed.

In contrast, `knox run` (single task) streams Claude's output line-by-line to
the terminal in real time. The queue orchestrator breaks this contract by only
forwarding agent output when `--verbose` is explicitly passed, and even then
it's raw prefixed lines on stderr with no structure.

The user is left staring at a silent terminal for minutes (or longer), unable to
distinguish "working" from "stuck," and must manually inspect log files to
understand what happened.

## Solution

Add a live-updating terminal UI (TUI) to the queue command that displays a
compact, always-visible dashboard of all queue items, their current phase, and
elapsed time. The TUI uses animated spinners to signal liveness and color coding
to communicate status at a glance.

When `--verbose` is passed, a scrolling log panel appears below the table
showing color-coded agent output from running items. The TUI auto-detects TTY
availability and falls back to static scrolling log lines in non-TTY
environments (CI, pipes). A `--no-tui` flag provides an explicit opt-out.

## User Stories

1. As a Knox user running a queue, I want to see which items are running,
   pending, completed, or failed at a glance, so that I know the overall
   progress without inspecting log files.

2. As a Knox user running a queue, I want to see an animated spinner next to
   running items, so that I can tell the process is alive and not hung.

3. As a Knox user running a queue, I want to see the current loop number (e.g.,
   "loop 2/5") for each running item, so that I know how far along each item is.

4. As a Knox user running a queue, I want to see the current phase of each
   running item (container setup, agent running, check running, bundling,
   committing), so that I understand what Knox is doing at any moment.

5. As a Knox user running a queue, I want to see elapsed time per item and total
   wall time, so that I can gauge whether a run is taking longer than expected.

6. As a Knox user running a queue, I want completed items to show their result
   branch name (e.g., `knox/item-d-abc123`), so that I can start reviewing
   without waiting for the summary.

7. As a Knox user running a queue, I want failed items to show a brief inline
   error reason (e.g., "failed: check exit 1"), so that I can quickly triage
   without opening log files.

8. As a Knox user running a queue, I want blocked items to show what they're
   blocked by (e.g., "blocked by item-a"), so that I understand the dependency
   chain.

9. As a Knox user running a queue, I want to see aggregate counts in the header
   (e.g., "2 running, 1 done, 2 pending"), so that I can quickly assess overall
   progress.

10. As a Knox user running a queue with `--verbose`, I want to see a scrolling
    log panel below the status table showing live agent output, so that I can
    monitor what Claude is saying without opening a separate terminal.

11. As a Knox user running a queue with `--verbose` and concurrency > 1, I want
    agent output lines prefixed and color-coded by item ID, so that I can
    visually distinguish which item produced which output.

12. As a Knox user running a queue in CI or piping output, I want the TUI to
    automatically fall back to static scrolling log lines, so that I get clean
    output without ANSI escape codes.

13. As a Knox user, I want a `--no-tui` flag to explicitly disable the TUI and
    get static log lines, so that I can opt out even in a TTY context.

14. As a Knox user, I want the TUI to handle Ctrl+C gracefully — updating
    running items to show "aborted," freezing the display, and printing the
    summary below, so that I can see what completed before the interruption.

15. As a Knox user, I want the TUI frame to freeze in place when the queue
    finishes and the summary to print below it, so that my scrollback contains
    both the final state and the summary.

16. As a Knox user, I want the TUI to handle terminal resize without breaking,
    so that the display adjusts if I change my terminal window size mid-run.

17. As a Knox user running a queue without `--verbose`, I want agent output to
    still be captured to per-item log files on disk, so that I can inspect them
    after the fact.

18. As a Knox user, I want color coding for item status — green for completed,
    red for failed, yellow for running/aborted, dim for pending/blocked — so
    that I can scan the table quickly.

19. As a Knox user running `--verbose` in a non-TTY environment, I want full
    agent output printed as static prefixed lines (the current behavior), so
    that verbose mode is still useful outside a terminal.

20. As a Knox user with a large queue (20+ items), I want the table to remain
    usable, scrolling or truncating if it exceeds terminal height, so that the
    display doesn't break.

## Implementation Decisions

### New module: QueueTUI

A deep module that encapsulates all terminal rendering. Its public interface is:

- `constructor(items: string[], options: { verbose: boolean, tty: boolean })` —
  initializes state for all items
- `update(itemId: string, event: KnoxEvent)` — mutates internal state based on
  structured engine events
- `appendLine(itemId: string, line: string)` — buffers agent output for the log
  panel
- `start()` — begins the 80ms render interval
- `stop()` — freezes the last frame, stops the interval

Internally manages:

- ANSI cursor movement and line clearing for in-place updates
- Braille spinner animation (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) cycling at 80ms
- Per-item state machine: pending → running (with sub-phases) →
  completed/failed/blocked/aborted
- Rolling log buffer sized to remaining terminal height (terminal rows minus
  table rows)
- Color palette cycling per item (cyan, magenta, yellow, blue, green) for log
  panel prefixes
- Terminal resize handling via `SIGWINCH` or equivalent

Status icons:

- `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` (animating) — running (yellow)
- `✓` — completed (green)
- `✗` — failed (red)
- `⚠` — aborted (yellow)
- `○` — blocked (dim)
- `·` — pending (dim)

Phase display per item maps directly from existing `KnoxEvent` types:

- `container:created` → "setting up"
- `loop:start { loop, maxLoops }` → "loop 2/5"
- `loop:end { completed: true }` → "agent complete"
- `check:failed` → "check failed, retrying"
- `nudge:result` → "committing"
- `bundle:extracted` → "extracting results"
- `aborted` → "aborted"

### Modified module: Orchestrator

Add `onEvent: (itemId: string, event: KnoxEvent) => void` to
`OrchestratorOptions`, mirroring the existing `onLine` callback pattern. In
`runItem`, wire this callback into the Knox engine's `onEvent` option, binding
the item ID.

### Modified module: CLI queue command

- Add `--no-tui` to the `parseArgs` boolean flags
- Detect TTY via `Deno.stdout.isTerminal()`
- When TUI is active: create `QueueTUI`, wire `onEvent` and `onLine` to it, call
  `start()` before orchestrator runs and `stop()` after
- When TUI is inactive (non-TTY or `--no-tui`): use a static fallback that maps
  events to timestamped log lines on stderr, and forwards `onLine` with item
  prefixes when `--verbose` is set
- Handle Ctrl+C: the existing `AbortController` wiring stays; the TUI's `update`
  method handles the `aborted` event to update display before `stop()` is called

### Static fallback renderer

For non-TTY or `--no-tui` mode: a thin adapter with the same
`update(itemId, event)` interface that prints static timestamped log lines to
stderr. Can be inline in the CLI or a small companion to `QueueTUI`. Example
output:

```
[12:01:03] [item-a] container created
[12:01:15] [item-a] loop 1/5 started
[12:02:41] [item-a] loop 1/5 completed
```

### Render architecture

A single `setInterval` at 80ms drives the render loop. State mutations happen
asynchronously when `update()` or `appendLine()` are called from orchestrator
callbacks. The render function reads current state and draws — no race
conditions since Deno is single-threaded for the event loop.

On finish: the render interval is cleared, the last frame remains in the
terminal, and the existing `printSummary` output appears below it.

On Ctrl+C: running items are updated to aborted state, one final render occurs,
then the frame freezes and summary prints.

### Layout

```
knox queue — <queue-name> (<elapsed>)  N running · N done · N failed · N pending

  <icon> <item-id>     <loop>    <phase>                    <elapsed>
  ...
────────────────────────────────────────────────────────────────────── (verbose only)
  [item-a] <agent output line>
  [item-b] <agent output line>
  ...
```

## Testing Decisions

Good tests for this feature verify external behavior through public interfaces,
not rendering internals.

### Modules to test

**QueueTUI state machine** — Extract the event-to-display-state mapping into a
pure function. Test that sequences of `KnoxEvent` inputs produce the correct
display state (status, phase text, loop count, error message, icon). No terminal
or ANSI codes involved. This is the core logic and is trivially unit-testable.

**Orchestrator `onEvent` wiring** — The orchestrator already has test
infrastructure using `engineFactory` mocks. Add tests verifying that `onEvent`
is called with the correct `(itemId, event)` pairs when the engine emits events.
Mirrors existing `onLine` wiring tests.

**Static fallback renderer** — Test that event sequences produce the expected
formatted log lines. Snapshot-style string assertions.

### What NOT to test

ANSI rendering, cursor movement, and spinner animation. These are visual
concerns best verified by manual inspection. The state machine extraction
ensures the logic is correct; the rendering layer is a thin, dumb projection of
that state.

### Prior art

Existing orchestrator tests use `engineFactory` to inject mock engines and
verify callback behavior. Follow the same pattern for `onEvent`.

## Out of Scope

- Per-item output filtering in the TUI (use
  `tail -f <queue>.logs/<item>.log | grep` instead)
- Web-based dashboard or external monitoring
- Historical run visualization
- Modifying `knox run` (single task) output — it already streams correctly
- Adding new `KnoxEvent` types — the existing set covers all phase transitions
- Setup command visibility in the TUI — setup runs during image build before the
  orchestrator loop

## Further Notes

- The per-item log files (`<queue-name>.logs/<item-id>.log`) continue to capture
  full agent output regardless of TUI mode. The TUI is additive visibility, not
  a replacement for log files.
- The `onEvent` addition to the orchestrator is independently useful beyond the
  TUI — it enables future integrations (webhooks, external dashboards) without
  changing the orchestrator again.
- The 80ms render interval is cheap — it's just writing a few dozen ANSI-escaped
  lines to stdout. No performance concern even on large queues.
- Color palette for the log panel (cyan, magenta, yellow, blue, green) cycles
  and repeats for queues with more than 5 items. Sufficient for visual
  separation at typical concurrency levels (2-4).
