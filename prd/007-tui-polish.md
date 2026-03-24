# PRD 007: Queue TUI Polish — Flicker Fix, Abort UX, and Summary Line

## Problem Statement

The queue TUI works but has two UX issues that make it feel unfinished:

1. **Flickering**: The TUI visibly flashes on each render cycle. The current rendering strategy clears all previous lines before writing the new frame, creating a gap where blank lines are visible. This makes the tool feel buggy.

2. **Poor abort feedback**: When the user presses Ctrl+C, there is no immediate indication that the abort was received. Running containers are allowed to finish naturally rather than being killed, so the user waits with no feedback. There is no human-readable summary of what happened after the TUI exits.

## Solution

Three targeted improvements to the queue TUI:

1. **Eliminate flickering** by switching to overwrite-in-place rendering — write each new frame directly over the previous one in a single buffered write, rather than clearing first.

2. **Kill containers immediately on abort** and show clear visual feedback throughout the abort lifecycle: an `[Aborting...]` banner while containers are being killed, then `[Aborted]` in the final frozen frame.

3. **Always print a human-readable summary line** to stderr after the TUI stops, for both normal and aborted runs.

## User Stories

1. As a developer running a queue, I want the TUI to render without flickering, so that the tool feels polished and trustworthy.
2. As a developer running a queue, I want to press Ctrl+C and immediately see confirmation that my abort was received, so that I know the tool is responding.
3. As a developer who aborts a queue, I want running containers to be killed immediately, so that I am not left waiting for work I no longer care about.
4. As a developer who aborts a queue, I want to see items transition from "running" to "aborted" in the TUI, so that I understand what happened to each item.
5. As a developer who aborts a queue, I want the final TUI frame to say `[Aborted]`, so that the frozen output clearly reflects that the run was interrupted.
6. As a developer running a queue, I want a one-line summary printed after the TUI exits, so that I can see the outcome at a glance without parsing JSON.
7. As a developer whose queue completes normally, I want the summary line to show counts and elapsed time, so that I have a quick record of what happened.
8. As a developer whose queue has failures, I want the summary prefix to say "Failed" rather than "Completed", so that the outcome is unambiguous.
9. As a developer running a large queue that exceeds terminal height, I want the TUI to never scroll past the viewport, so that cursor-based rendering remains correct.
10. As a developer running a queue in a non-TTY environment, I want none of these rendering changes to affect the static renderer fallback, so that piped output remains clean.

## Implementation Decisions

### Rendering: Overwrite-in-Place

- Replace the current `clearPrevious()` strategy (cursor-up, clear each line, cursor-up) with overwrite-in-place rendering.
- Each line of the new frame is prefixed with carriage return + clear-line escape (`\r\x1b[2K`), writing directly over the previous content.
- The entire frame is assembled into a single string and written with one `writeSync` call, minimizing the window for visible artifacts.
- If the new frame has fewer lines than the previous frame, the remaining "orphan" lines are explicitly cleared after writing.
- Frame height is capped to `rows - 1` to prevent the terminal from scrolling, which would break cursor-up positioning.

### Abort: Engine Kills Its Own Containers

- The Knox engine (`knox.ts`) is solely responsible for container lifecycle, including kill-on-abort. The orchestrator does not need to track or kill containers.
- After creating a `ContainerSession`, the engine registers an `abort` event listener on the signal that calls `session.dispose()`. This triggers `docker rm -f`, which kills the container immediately.
- The listener is removed in the `finally` block before the normal dispose path. `ContainerSession.dispose()` is already idempotent (has a `disposed` guard), so double-calls are safe.
- When `docker rm -f` kills a container mid-`docker exec`, the exec subprocess errors. Each phase catch block in the engine checks `signal?.aborted` first — if true, it returns `makeAbortResult()` (status: aborted) instead of a failure result.
- Items killed mid-execution show as "aborted", not "failed".

### Abort: TUI Feedback Progression

- A new `setAborting()` method is added to `QueueTUI`, called from the SIGINT handler in `cli.ts`.
- While the `aborting` flag is set, the header renders as: `QueueName [Aborting...] elapsed  counts`
- The final frozen frame (after all engines return and `stop()` is called) renders as: `QueueName [Aborted] elapsed  counts`
- Progression: normal header → `[Aborting...]` (live) → `[Aborted]` (frozen).

### Summary Line

- A human-readable summary line is printed to stderr after the TUI stops, before the JSON report on stdout.
- Format: `{Prefix}: N completed, N failed, ...  (elapsed)`
- Prefix logic: `Completed` if all items succeeded, `Failed` if any failed, `Aborted` if the run was interrupted.
- Printed for all runs (normal, failed, and aborted), not just aborts.
- The TUI already tracks aggregate counts and start time, so the data is available — it just needs a formatter.

## Testing Decisions

Good tests in this project verify external behavior through the public interface, not implementation details. Tests use `Deno.test` with `@std/assert` and are located in the `test/` directory mirroring the `src/` structure.

### Modules to Test

1. **QueueTUI rendering** (`test/queue/tui/queue_tui_test.ts`): Existing tests verify rendered output by capturing `writeSync` calls. Add tests for:
   - Overwrite-in-place: verify that the output contains `\r\x1b[2K` prefixes per line, not the old clear-then-write sequence.
   - Orphan line clearing: render a tall frame, then a short frame, verify stale lines are cleared.
   - Abort banner: call `setAborting()`, verify header contains `[Aborting...]`. Call `stop()`, verify header contains `[Aborted]`.
   - Summary line: verify the summary is written after `stop()` with correct prefix and counts.

2. **Knox engine abort** (`test/knox_test.ts`): Existing tests cover the engine with mocked runtimes and providers. Add tests for:
   - Abort mid-agent-loop: fire abort signal while agent runner is executing, verify the result is `{ ok: true, aborted: true }` not `{ ok: false }`.
   - Dispose is called: verify `session.dispose()` is triggered by the abort signal (mock runtime can track calls).

3. **TUI state machine** (`test/queue/tui/state_test.ts`): Already comprehensive. No changes needed unless state types change.

### Prior Art

- `test/queue/tui/queue_tui_test.ts` — captures stderr output for rendered frame assertions.
- `test/knox_test.ts` — uses mock runtime, source provider, and sink to test engine behavior without Docker.
- `test/queue/orchestrator_test.ts` — comprehensive orchestrator tests with event tracking.

## Out of Scope

- **Second Ctrl+C force exit**: A pattern where a second Ctrl+C calls `Deno.exit(1)` immediately if the first abort is taking too long. Useful but separate concern.
- **Orphaned container cleanup**: Recovering containers from crashed runs that left no process to clean them up.
- **Static renderer changes**: The non-TTY fallback renderer is unaffected by these changes.
- **Render interval tuning**: The 80ms / 12.5fps refresh rate is fine; flickering is caused by the rendering strategy, not the frame rate.
- **Spinner animation changes**: Current braille spinner frames and speed are acceptable.

## Further Notes

- The `ContainerSession.dispose()` method is already idempotent, which simplifies the abort listener pattern in the engine.
- The abort signal is already plumbed through from CLI → orchestrator → engine → agent runner. The main gap is that the engine only *checks* the signal at phase boundaries rather than *reacting* to it immediately.
- The overwrite-in-place rendering technique is the standard approach used by tools like `docker pull`, `npm install`, and `cargo build` progress displays.
