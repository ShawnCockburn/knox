# Plan: Repo Restructure & Engine Extraction

> Source PRD: prd/005-queue-orchestrator.md (Parts 1 and 3)

## Architectural decisions

Durable decisions that apply across all phases:

- **Module boundaries**: `src/engine/`, `src/cli/`, `src/orchestrator/`,
  `src/shared/` — enforced by convention, not packages
- **Import rules**: `engine/` never imports from `cli/` or `orchestrator/`.
  `shared/` never imports from any of the other three.
- **Engine contract**: Engine takes fully resolved inputs (image, envVars,
  allowedIPs). No self-resolving, no "skip" flags.
- **Result type**: Engine returns `KnoxOutcome` discriminated union (`ok: true`
  | `ok: false` with `phase`), never throws for expected failures.
- **Cancellation**: `AbortSignal` — standard API, checked at loop boundaries,
  produces `aborted: true` result (not an error).
- **Event channel**: `onEvent` callback with typed `KnoxEvent` union, separate
  from `onLine` raw agent stream.
- **CLI subcommands**: `knox run` (single task), `knox queue` (orchestrated).
  Single binary.

---

## Phase 1: Module boundaries

**Goal**: Reorganize `src/` into `shared/`, `engine/`, and `cli/` directories.
No behavior change — pure file moves and import updates.

### What to build

Move every module into its target directory. The repo goes from a flat `src/`
with peer directories to a layered structure where shared utilities, the engine,
and the CLI each have a clear home.

`shared/` gets: `auth/`, `image/`, `knox/` (resolveAuth, resolveAllowedIPs),
`preflight/`, `runtime/`, `log.ts`, `types.ts`.

`engine/` gets: `knox.ts`, `session/`, `agent/`, `source/`, `sink/`, `prompt/`.

`cli/` gets: `cli.ts` and `cli/format.ts`.

Each directory gets a `mod.ts` barrel. The root `src/mod.ts` re-exports from
`engine/mod.ts` and `shared/mod.ts` to preserve the existing public API surface.

Update all internal imports. Update `deno.json` entry point if needed. Update
test imports.

### Acceptance criteria

- [ ] Directory structure matches: `src/{shared,engine,cli}/` with barrel
      exports
- [ ] All existing tests pass with zero behavior change
- [ ] `deno check` passes — no broken imports
- [ ] `engine/` has no imports from `cli/` or `orchestrator/`
- [ ] `shared/` has no imports from `engine/`, `cli/`, or `orchestrator/`
- [ ] Root `src/mod.ts` re-exports preserve the existing public API

---

## Phase 2: Dumb engine

**Goal**: Remove pre-container logic from the engine. The engine requires fully
resolved inputs — caller does the prep.

### What to build

Change `KnoxEngineOptions` to require `image: ImageId`, `envVars: string[]`, and
`allowedIPs: string[]`. Remove `setup`, `env`, `promptPath`, and `skipPreflight`
from engine options. If the caller wants a custom prompt, they read the file and
pass `customPrompt: string`.

Remove from `Knox.run()`:

- `PreflightChecker.check()` call
- `ImageManager.ensureSetupImage()` call
- `resolveAuth()` call
- `resolveAllowedIPs()` call
- Custom prompt file reading (`Deno.readTextFile`)

The CLI layer (`src/cli/`) picks up this work: resolve auth, resolve IPs, ensure
image, run preflight — then pass resolved values to the engine.

Update all tests — engine tests no longer need to mock preflight/auth/image. CLI
tests verify the prep-then-run flow.

### Acceptance criteria

- [ ] `KnoxEngineOptions` requires `image`, `envVars`, `allowedIPs` — no
      optional resolution
- [ ] `Knox.run()` has no calls to `resolveAuth`, `resolveAllowedIPs`,
      `ImageManager`, or `PreflightChecker`
- [ ] CLI performs all pre-container setup before calling engine
- [ ] Engine constructor has no `skipPreflight`, `promptPath`, `setup`, or `env`
      fields
- [ ] All tests pass — engine tests are simpler (no preflight/auth mocking)
- [ ] Library usage example in README/docs updated

---

## Phase 3: Result union + Run ID passthrough

**Goal**: Engine returns a typed result union instead of throwing. Run ID flows
through options and result.

### What to build

Define `KnoxOutcome` as a discriminated union:

- `{ ok: true; result: KnoxResult }` — success
- `{ ok: false; error: string; phase: FailurePhase; partial?: Partial<KnoxResult> }`
  — expected failure

Define `FailurePhase` as `"container" | "agent" | "bundle" | "sink"`.

Wrap the engine's try/catch in `Knox.run()` to catch expected failures and
return `{ ok: false, ... }` with the appropriate phase. True bugs (programming
errors) still throw.

Add optional `runId?: RunId` to `KnoxEngineOptions`. If provided, use it;
otherwise generate one. Add `runId: RunId` to `KnoxResult` (always present).

Update CLI to pattern-match on `outcome.ok` instead of try/catch. Map failure
phases to exit codes.

### Acceptance criteria

- [ ] `Knox.run()` returns `Promise<KnoxOutcome>`, not `Promise<KnoxResult>`
- [ ] Container creation failure returns `{ ok: false, phase: "container" }`
- [ ] Agent execution failure returns `{ ok: false, phase: "agent" }`
- [ ] Bundle extraction failure returns `{ ok: false, phase: "bundle" }`
- [ ] Sink collection failure returns `{ ok: false, phase: "sink" }`
- [ ] `partial` field contains whatever was populated before failure
- [ ] `runId` accepted in options, always present in result
- [ ] CLI handles `KnoxOutcome` without try/catch for expected failures
- [ ] All tests updated to assert on `KnoxOutcome` shape

---

## Phase 4: AbortSignal + lifecycle events

**Goal**: Engine supports programmatic cancellation and emits structured
lifecycle events.

### What to build

Accept `signal?: AbortSignal` in `KnoxEngineOptions`. Check `signal.aborted` at
these points:

- Before each agent loop in `AgentRunner`
- Before bundle extraction
- Before sink collection

On abort: clean up the container, return
`{ ok: true, result: { ...partialResult, aborted: true } }` — abort is a normal
outcome, not an error.

Replace the CLI's `Deno.addSignalListener("SIGINT")` with an `AbortController`.
On SIGINT, call `controller.abort()`. The signal flows to the engine through
options.

Define `KnoxEvent` discriminated union and add
`onEvent?: (event: KnoxEvent) => void` to `KnoxEngineOptions`. Emit events at:

- Preflight complete (if preflight is the caller's job, this may not apply —
  emit at engine boundaries: container created, loop start/end, check result,
  nudge result, bundle extracted, aborted)
- Loop start and end
- Check failure
- Commit nudge result
- Bundle extraction
- Abort

### Acceptance criteria

- [ ] `AbortSignal` accepted in engine options
- [ ] Aborting mid-run cleans up container and returns `aborted: true`
- [ ] CLI uses `AbortController` → SIGINT → `controller.abort()`
- [ ] `onEvent` callback fires at each lifecycle point
- [ ] `KnoxEvent` is a discriminated union with `type` field
- [ ] `onLine` and `onEvent` are independent — either, both, or neither can be
      provided
- [ ] Tests verify abort at loop boundary produces clean result
- [ ] Tests verify event sequence for a successful run

---

## Phase 5: Source provider ref parameter

**Goal**: `GitSourceProvider` can clone a specific branch, enabling chained
execution.

### What to build

Add an optional `ref` parameter to `GitSourceProvider`'s constructor options.
When provided, the shallow clone targets that ref instead of HEAD.

```
git clone --depth 1 --branch <ref> <repo> <dest>
```

Default behavior (no ref) is unchanged — clones HEAD.

### Acceptance criteria

- [ ] `GitSourceProvider` accepts optional `ref` in constructor options
- [ ] When `ref` is provided, clones that specific branch
- [ ] When `ref` is omitted, behavior is identical to current (HEAD)
- [ ] Test: clone with ref produces workspace containing that branch's content
- [ ] Test: clone without ref produces workspace containing HEAD content

---

## Phase 6: CLI subcommands

**Goal**: Restructure CLI to support `knox run` (single task) and `knox queue`
(placeholder for plan 2).

### What to build

Restructure the CLI arg parser to detect the subcommand:

- `knox run --task "..." [options]` — current single-task behavior
- `knox queue --file <path> [--resume] [--verbose]` — validates args, prints
  "not yet implemented", exits. Wired in plan 2.
- `knox` with no subcommand — print usage showing available subcommands

Move CLI code into `src/cli/` if not already there. The CLI module owns arg
parsing, pre-container setup, output formatting, and exit codes.

### Acceptance criteria

- [ ] `knox run --task "..."` works identically to current `knox --task "..."`
- [ ] `knox queue --file <path>` parses args and validates the file exists
- [ ] `knox queue` without `--file` prints an error
- [ ] `knox` with no subcommand prints usage
- [ ] Exit codes preserved: 0 (success), 1 (incomplete), 2 (preflight), 3
      (crash)
- [ ] All CLI tests updated for subcommand structure
