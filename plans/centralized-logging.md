# Plan: Centralized Logging

> Source PRD: prd/003-centralized-logging.md

## Architectural decisions

Durable decisions that apply across all phases:

- **New module**: `src/log.ts` — module singleton, no class instantiation
- **Methods**: `log.debug()`, `log.info()`, `log.warn()`, `log.error()`,
  `log.always()`, `log.setLevel()`
- **Prefix format**: `[knox:LEVEL]` (uppercase) for leveled methods; `[knox]`
  for `always()`
- **Output target**: All logger output to stderr via `console.error()` — stdout
  reserved for agent output
- **Colors**: gray (debug), none (info), yellow (warn), red (error), none
  (always)
- **Color suppression**: Respects `NO_COLOR` env var and
  `Deno.stderr.isTerminal()`
- **CLI flags**: `--verbose` sets debug, `--quiet` sets warn, mutually exclusive
- **Test file**: `test/log_test.ts`

---

## Phase 1: Logger core with level filtering

**User stories**: 8, 9, 10, 12

### What to build

Create the centralized logger module as a module singleton with four severity
methods (`debug`, `info`, `warn`, `error`), an unconditional `always` method,
and a `setLevel` function to configure the threshold. Each method auto-prefixes
its output with `[knox:LEVEL]` and writes to stderr. `always` uses the prefix
`[knox]` (no level tag) and is never suppressed regardless of threshold. No
color support yet — all prefixes are plain text.

### Acceptance criteria

- [ ] Importing `log` from `src/log.ts` provides `debug`, `info`, `warn`,
      `error`, `always`, and `setLevel`
- [ ] Default threshold is `info` — `debug` messages are suppressed,
      `info`/`warn`/`error` are emitted
- [ ] `setLevel("debug")` causes `debug` messages to appear
- [ ] `setLevel("warn")` suppresses `info` and `debug`
- [ ] `setLevel("error")` suppresses everything below `error`
- [ ] `always()` is never suppressed at any level
- [ ] Leveled messages are prefixed `[knox:DEBUG]`, `[knox:INFO]`,
      `[knox:WARN]`, `[knox:ERROR]`
- [ ] `always()` messages are prefixed `[knox]`
- [ ] All output goes to stderr
- [ ] Logger never calls `process.exit()` or `Deno.exit()`
- [ ] Tests in `test/log_test.ts` cover level filtering, prefix formatting,
      `always` behavior, and `setLevel` runtime changes

---

## Phase 2: Color support

**User stories**: 5, 6

### What to build

Add ANSI color codes to log prefixes: gray for debug, yellow for warn, red for
error. Info and always remain uncolored. Color is enabled only when stderr is a
TTY and the `NO_COLOR` environment variable is not set. The implementation is
hand-rolled — four ANSI constants and a check function, no external dependency.

### Acceptance criteria

- [ ] Debug prefix is gray (`\x1b[90m`)
- [ ] Warn prefix is yellow (`\x1b[33m`)
- [ ] Error prefix is red (`\x1b[31m`)
- [ ] Info and always prefixes have no color codes
- [ ] Color is suppressed when `NO_COLOR` env var is set (any value)
- [ ] Color is suppressed when stderr is not a TTY
- [ ] Tests verify correct ANSI codes when color is enabled
- [ ] Tests verify plain prefixes when color is suppressed

---

## Phase 3: CLI flags and call-site migration

**User stories**: 1, 2, 3, 4, 7, 11

### What to build

Add `--verbose` and `--quiet` flags to the CLI. Wire them to `log.setLevel()`
after arg parsing and before `runKnox()`. Make the two flags mutually exclusive
— error if both provided. Then replace all 32 `console.error("[knox] ...")`
calls across `knox.ts`, `cli.ts`, and `auth/get_credential.ts` with the
appropriate `log.*()` call. Reclassify messages per the PRD: container ID,
allowed IPs, image hash, auth method, and network restriction confirmation move
to `debug`; summary output routes through `log.always()`. CLI validation errors
(arg parsing) remain as raw `console.error()` since they fire before the logger
is configured.

### Acceptance criteria

- [ ] `--verbose` sets log level to debug
- [ ] `--quiet` sets log level to warn
- [ ] Passing both `--verbose` and `--quiet` prints an error and exits with code
      2
- [ ] Default run (no flag) shows info-level breadcrumbs: preparing source,
      creating container, starting loop, etc.
- [ ] `--verbose` additionally shows: container ID, allowed IPs, image hash,
      auth method, network restriction
- [ ] `--quiet` suppresses info messages; only warnings, errors, and `always`
      output appear
- [ ] `formatSummary` output is routed through `log.always()` and always prints
      regardless of level
- [ ] Agent stdout streaming remains as raw `console.log()` — untouched
- [ ] CLI validation errors remain as raw `console.error()` — untouched
- [ ] No `console.error("[knox]` calls remain in `knox.ts`, `cli.ts`, or
      `auth/get_credential.ts` (except CLI validation)
