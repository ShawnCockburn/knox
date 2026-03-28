# Plan: TUI Polish — Flicker Fix, Abort UX, Summary Line

> Source PRD: prd/007-tui-polish.md

## Architectural decisions

- **Rendering strategy**: Overwrite-in-place with single buffered `writeSync`.
  No alternate screen buffer — final frame must remain visible in scrollback.
- **Abort ownership**: The Knox engine is solely responsible for killing its own
  containers. The orchestrator signals abort; the engine reacts. No
  cross-boundary container tracking.
- **Container kill method**: `session.dispose()` (which calls `docker rm -f`).
  Already idempotent via `disposed` guard.
- **Abort result type**: Killed items return `{ ok: true, aborted: true }`, not
  `{ ok: false }`. The "aborted" display status already exists in the TUI state
  machine.
- **Summary output**: Always printed to stderr after TUI stops, before JSON
  report on stdout.

---

## Phase 1: Flicker-free rendering

**User stories**: 1, 9

### What to build

Replace the current clear-then-write rendering strategy in `QueueTUI` with
overwrite-in-place. Instead of moving the cursor up, clearing each line, moving
back up, then writing the new frame — move the cursor to the start of the frame
and write each line prefixed with a clear-line escape, overwriting the previous
content directly. Assemble the entire frame into a single string and write it
with one `writeSync` call.

When the new frame has fewer lines than the previous frame, clear the orphan
lines after writing. Cap the total frame height to `rows - 1` to prevent
terminal scrolling, which breaks cursor-up positioning.

### Acceptance criteria

- [ ] TUI renders without visible flickering on a TTY
- [ ] Each render cycle produces a single `writeSync` call (excluding the
      initial cursor-home move)
- [ ] When frame height shrinks between renders, stale lines from the previous
      frame are cleared
- [ ] Frame height never exceeds terminal rows minus one
- [ ] Test: captured write output contains `\r\x1b[2K` line prefixes instead of
      the old clear-all-then-write sequence
- [ ] Test: rendering a tall frame followed by a short frame clears orphan lines

---

## Phase 2: Kill on abort with TUI feedback

**User stories**: 2, 3, 4, 5

### What to build

Two connected changes that together deliver the abort experience:

**Engine kill**: After the Knox engine creates a `ContainerSession`, it
registers an `abort` event listener on the signal that calls `session.dispose()`
immediately. This kills the container via `docker rm -f`, causing the in-flight
`docker exec` subprocess to error. Each phase catch block in the engine checks
`signal?.aborted` first — if true, returns `makeAbortResult()` instead of a
failure. The listener is removed in the `finally` block before the normal
dispose path (dispose is idempotent, but removing the listener is cleaner).

**TUI feedback**: Add a `setAborting()` method to `QueueTUI` that sets an
internal flag. The SIGINT handler in the CLI calls this immediately after
`controller.abort()`. While the flag is set, the header renders with an
`[Aborting...]` label. When `stop()` is called (after all engines return), the
final frozen frame renders with `[Aborted]` instead. Progression: normal →
`[Aborting...]` (live) → `[Aborted]` (frozen).

### Acceptance criteria

- [ ] Pressing Ctrl+C immediately kills running containers (no waiting for phase
      boundaries)
- [ ] Items killed mid-execution show as "aborted" in the TUI, not "failed"
- [ ] The engine returns `{ ok: true, aborted: true }` for killed items, not
      `{ ok: false }`
- [ ] The TUI header shows `[Aborting...]` immediately after Ctrl+C
- [ ] The final frozen TUI frame shows `[Aborted]`
- [ ] `session.dispose()` is not called twice (abort listener is removed before
      finally block)
- [ ] Test (engine): aborting mid-agent-loop returns an abort result, not a
      failure
- [ ] Test (engine): `dispose` is triggered by the abort signal (mock runtime
      tracks calls)
- [ ] Test (TUI): calling `setAborting()` causes the header to contain
      `[Aborting...]`
- [ ] Test (TUI): after `stop()` with aborting set, header contains `[Aborted]`

---

## Phase 3: Summary line

**User stories**: 6, 7, 8, 10

### What to build

After the TUI stops (whether normally, with failures, or after abort), print a
one-line human-readable summary to stderr before the JSON report goes to stdout.

Format: `{Prefix}: N completed, N failed, ...  (elapsed)`

Prefix logic:

- `Aborted` if the run was interrupted
- `Failed` if any items failed (but not aborted)
- `Completed` if all items succeeded

The TUI already tracks aggregate counts and start time. Add a method that
formats these into the summary string. The CLI calls this after
`renderer.stop()` and writes it to stderr.

This summary also prints for non-TUI (static renderer) runs so that piped/CI
output gets a human-readable outcome line.

### Acceptance criteria

- [ ] A summary line is printed to stderr after every run (normal, failed,
      aborted)
- [ ] Prefix is `Completed` when all items succeed
- [ ] Prefix is `Failed` when any item failed
- [ ] Prefix is `Aborted` when the run was interrupted
- [ ] Summary includes item counts and total elapsed time
- [ ] Summary prints for both TUI and static renderer modes
- [ ] Test: summary line format matches expected pattern for each outcome type
