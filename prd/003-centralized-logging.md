# Knox — Centralized Logging

## Problem Statement

Knox has 32 `console.error()` calls scattered across 3 source files, all manually prefixed with `[knox]`. There is no logging abstraction, no log levels, and no way for users to control verbosity. Every status message, warning, and error uses the same mechanism — a raw `console.error()` with a hand-typed prefix. This means:

1. **No verbosity control**: Users cannot suppress noisy status messages or enable debug detail. There is no `--quiet` for scripted usage or `--verbose` for troubleshooting.
2. **Repetitive boilerplate**: Every log call manually includes the `[knox]` prefix and routes through `console.error()`.
3. **No level distinction**: Warnings, errors, and informational messages are visually identical — the user has to read the text to judge severity.
4. **No color**: Log levels have no visual differentiation in the terminal.

## Solution

Introduce a centralized logger module (`src/log.ts`) as a module singleton with four severity levels (`debug`, `info`, `warn`, `error`) plus an unconditional `always` method. The logger auto-prefixes messages with `[knox:LEVEL]`, colorizes output per level, and respects a configurable threshold.

Two new CLI flags (`--verbose`, `--quiet`) let users shift the default `info` threshold to `debug` or `warn` respectively. All existing `console.error("[knox] ...")` calls are replaced with the appropriate `log.*()` call. Several current info-level messages are reclassified to `debug` (container ID, allowed IPs, image hash, auth method).

Key properties:
- All logger output goes to stderr (`console.error`), preserving stdout for agent output.
- Agent stdout streaming stays as raw `console.log()` — untouched by the logger.
- CLI validation errors (arg parsing) stay as raw `console.error()` — they fire before the logger is configured.
- The summary output uses `log.always()`, which is never suppressed.
- The logger never calls `process.exit()` — callers own control flow.

## User Stories

1. As a developer running knox interactively, I want to see progress breadcrumbs (preparing source, creating container, starting loop) by default, so that I know the tool isn't hanging.
2. As a developer troubleshooting a failed run, I want to pass `--verbose` to see debug detail (container ID, resolved IPs, auth method, image hash), so that I can diagnose the problem without modifying code.
3. As a developer using knox in a CI pipeline, I want to pass `--quiet` to suppress informational messages and only see warnings and errors, so that my build logs aren't cluttered.
4. As a developer piping agent output, I want `--quiet` to silence knox status messages on stderr while preserving agent stdout, so that my pipe is clean.
5. As a developer, I want warnings to appear in yellow and errors in red, so that I can quickly spot problems in terminal output.
6. As a developer whose terminal does not support color (or who sets `NO_COLOR`), I want the logger to respect that and emit plain text prefixes without ANSI codes.
7. As a developer, I want the task summary to always print regardless of log level, so that I always know the outcome of a run.
8. As a developer reading knox source code, I want a single `import { log }` to handle all logging, so that I don't have to manually type `console.error("[knox] ...")` and can't forget the prefix.
9. As a developer, I want each log line prefixed with `[knox:LEVEL]` (e.g., `[knox:INFO]`, `[knox:WARN]`), so that I can filter output by level using grep or other tools.
10. As a developer, I want the `log.always()` prefix to be `[knox]` (no level tag), so that unconditional output like the summary is visually distinct from leveled messages.
11. As a developer, I want debug-level messages (container ID, allowed IPs, auth method, image hash, network restriction confirmation) hidden by default, so that normal output stays concise.
12. As a contributor to knox, I want a simple `log.setLevel()` call to configure verbosity at startup, so that adding the logger to new code is trivial.

## Implementation Decisions

### New module: Logger (`src/log.ts`)

A module singleton exporting a `log` object with six methods:

- `log.debug(message)` — gray prefix `[knox:DEBUG]`, suppressed at info and above
- `log.info(message)` — plain prefix `[knox:INFO]`, the default threshold
- `log.warn(message)` — yellow prefix `[knox:WARN]`
- `log.error(message)` — red prefix `[knox:ERROR]`
- `log.always(message)` — plain prefix `[knox]`, unconditional (never suppressed by any level)
- `log.setLevel(level)` — sets the threshold; accepts `"debug" | "info" | "warn" | "error"`

Internal responsibilities:
- Level enum with numeric ordering for threshold comparison
- ANSI color codes: gray for debug, no color for info, yellow for warn, red for error, no color for always
- TTY detection (`process.stderr.isTTY`) and `NO_COLOR` env var support — when either disqualifies color, emit plain prefixes
- All output to stderr via `console.error()`
- Messages accept pre-interpolated strings (template literals) — no printf-style formatting

### CLI flag additions

Two new flags in `src/cli.ts`:
- `--verbose` — calls `log.setLevel("debug")`
- `--quiet` — calls `log.setLevel("warn")`
- Mutually exclusive; error if both provided
- Applied after arg parsing, before `runKnox()`

### Level reclassification of existing messages

**Reclassified to `debug`:**
- Container ID (`Container: abc123`)
- Allowed IPs (`Allowed IPs: ...`)
- Image ready (`Image ready: sha256:...`)
- Auth method selected (`Using OAuth credential...`, `Using ANTHROPIC_API_KEY...`)
- Network restricted confirmation

**Remain at `info`:**
- Ensuring agent image...
- Resolving authentication...
- Resolving API endpoints...
- Preparing source...
- Creating container (API-only network)...
- Copying source into container...
- Starting agent loop...
- Agent left uncommitted changes. Nudging to commit...
- Nudge did not produce a commit. Auto-committing...
- Creating git bundle...
- Extracting results...
- Task completed in N loop(s)
- Max loops reached
- Cleaning up container...
- Done.

**Remain at `warn`:**
- Preflight warnings
- Source preparation warnings
- OAuth token expired

**Remain at `error`:**
- Preflight errors
- Fatal exceptions

### Unchanged areas

- CLI validation errors (arg parsing): stay as raw `console.error()` — fire before logger is configured
- Agent stdout streaming: stays as raw `console.log(line)` — not a knox log message
- `formatSummary` output: routed through `log.always()`
- Logger never calls `process.exit()` — the caller owns exit decisions

## Testing Decisions

### What makes a good test

Tests should verify external behavior through the public API, not implementation details. For the logger, that means asserting on what gets written to stderr given a level and message — not on internal enum values or color code constants.

### Modules to test

**`src/log.ts`** — the only new module with real logic:
- Level filtering: messages below threshold are suppressed
- Prefix formatting: correct `[knox:LEVEL]` prefix per method
- `log.always()` is never suppressed regardless of level
- `log.always()` uses `[knox]` prefix (no level tag)
- Color output: correct ANSI codes per level when color is enabled
- Color suppression: no ANSI codes when `NO_COLOR` is set or stderr is not a TTY
- `setLevel()` changes the threshold at runtime

**Not tested (mechanical changes):**
- `src/knox.ts` — replacing `console.error` with `log.*` is a find-and-replace; testing the orchestrator already covers that these messages fire
- `src/cli.ts` — flag parsing for `--verbose`/`--quiet` is trivially covered by existing CLI test patterns
- `src/auth/get_credential.ts` — single line change

### Prior art

Tests live in `test/` mirroring the `src/` structure (e.g., `test/auth/credential_test.ts`, `test/cli/format_test.ts`). The new test file would be `test/log_test.ts`.

## Out of Scope

- **Structured/JSON logging** — Knox is a CLI tool, not a service. Plain text is appropriate.
- **Timestamps in log output** — Not needed for a CLI that runs for minutes, not hours.
- **Log-to-file support** — Users can redirect stderr if needed.
- **Per-module log namespaces** (e.g., `[knox:auth]`, `[knox:runtime]`) — Only 3 files emit logs; namespacing adds complexity with no navigational benefit at this scale.
- **`--log-level` flag** — `--verbose`/`--quiet` cover the real use cases. Can be added later if requested.
- **`log.fatal()` that exits** — Logger should not own control flow.
- **Color themes or customization** — Fixed color mapping per level is sufficient.

## Further Notes

- The hand-rolled ANSI color implementation should be minimal: 4 color constants + a check function. No external dependency needed.
- The `[knox:LEVEL]` prefix uses uppercase levels (e.g., `DEBUG`, `INFO`, `WARN`, `ERROR`) for visual weight and grepability.
- Since this is a module singleton, `setLevel()` is global — appropriate for a single-process CLI with one verbosity setting.
- The centralized logger makes future enhancements (timestamps, structured output, color themes) trivial to add without touching call sites.
