# Knox — Queue Orchestrator & Engine Extraction

## Problem Statement

Knox today is a single-run tool: one task, one container, one branch. A developer
who wants to execute a plan — a PRD broken into 8 tasks with dependencies between
them — must manually invoke Knox 8 times, sequencing dependent tasks, tracking
which succeeded, and managing the resulting branches. This is exactly the kind of
repetitive coordination work that should be automated.

The vision: a developer writes a PRD, breaks it into a queue of tasks with
dependencies, hands it to an orchestrator, and walks away. The orchestrator works
through the queue — respecting dependency order, running independent tasks in
parallel, chaining dependent tasks so each builds on its predecessor's output —
and produces neatly packaged branches with stacked commits.

This requires two things:

1. **Knox must become a dumber, more composable engine.** Today Knox resolves its
   own auth, builds its own images, runs its own preflight — convenient for CLI
   users, wasteful when an orchestrator runs 5 instances against the same repo.
   Pre-container logic must move out of the engine so callers can do it once and
   inject the results.

2. **A new orchestrator module must exist.** It owns scheduling (DAG resolution),
   concurrency, failure handling, state tracking, and result packaging — concerns
   that don't belong in the engine.

## Architecture: Module Boundaries

The repository reorganizes from a single-purpose tool into three modules with
explicit boundaries:

```
src/
  engine/         ← Knox engine: container session, agent runner, source/sink
    mod.ts        ← public API surface
  cli/            ← CLI entry point: pre-container setup + engine invocation
    mod.ts
  orchestrator/   ← Queue runner: scheduling, concurrency, state, reporting
    mod.ts
  shared/         ← resolveAuth, resolveAllowedIPs, ImageManager, preflight, types
    mod.ts
```

**Import rules:**
- `engine/` never imports from `cli/` or `orchestrator/`
- `cli/` imports from `engine/` and `shared/`
- `orchestrator/` imports from `engine/` and `shared/`
- `shared/` never imports from `engine/`, `cli/`, or `orchestrator/`

This is enforced by convention (module boundaries, not packages). If the project
outgrows this, the boundaries are already clean for package extraction.

## Part 1: Knox Engine Changes

### 1.1 Run ID passthrough

The engine accepts an optional `runId` in options and always returns it in the
result. If not provided, it generates one internally. This lets the orchestrator
assign IDs for correlation with queue items.

```typescript
interface KnoxEngineOptions {
  runId?: RunId;          // optional, defaults to generateRunId()
  // ... existing options
}

interface KnoxResult {
  runId: RunId;           // always present
  // ... existing fields
}
```

### 1.2 Cancellation via AbortSignal

The engine accepts an `AbortSignal` in options. It checks the signal at loop
boundaries and during long operations. On abort, it cleans up the container and
returns a result with `aborted: true` rather than throwing.

```typescript
interface KnoxEngineOptions {
  signal?: AbortSignal;
  // ...
}

interface KnoxResult {
  aborted: boolean;       // true if cancelled via signal
  // ...
}
```

The existing SIGINT handler in the CLI layer creates an `AbortController` and
feeds its signal to the engine — same abort path, two entry points.

### 1.3 Lifecycle events

The engine emits typed lifecycle events via an `onEvent` callback, separate from
the raw agent output stream (`onLine`).

```typescript
type KnoxEvent =
  | { type: "preflight"; ok: boolean }
  | { type: "image_ready"; imageId: string }
  | { type: "loop_start"; loop: number; maxLoops: number }
  | { type: "loop_end"; loop: number; completed: boolean }
  | { type: "check_failed"; loop: number; output: string }
  | { type: "commit_nudge"; succeeded: boolean }
  | { type: "bundle_extracted" }
  | { type: "aborted" };

interface KnoxEngineOptions {
  onEvent?: (event: KnoxEvent) => void;
  onLine?: (line: string) => void;
  // ...
}
```

`onLine` remains the raw agent stdout stream. `onEvent` is the structured
lifecycle channel the orchestrator cares about.

### 1.4 Engine becomes dumb

Pre-container logic moves out of the engine into `shared/`:

| Concern | Currently in | Moves to |
|---------|-------------|----------|
| `resolveAuth()` | `Knox.run()` | `shared/` (already extracted as function) |
| `resolveAllowedIPs()` | `Knox.run()` | `shared/` (already extracted as function) |
| `ImageManager.ensureSetupImage()` | `Knox.run()` | `shared/` |
| `PreflightChecker.check()` | `Knox.run()` | `shared/` |

The engine's constructor requires everything it needs upfront:

```typescript
interface KnoxEngineOptions {
  task: string;
  dir: string;
  runId?: RunId;
  image: ImageId;            // required — caller provides
  envVars: string[];         // required — caller provides (already resolved)
  allowedIPs: string[];      // required — caller provides
  maxLoops?: number;
  model?: string;
  check?: string;
  cpuLimit?: string;
  memoryLimit?: string;
  customPrompt?: string;
  signal?: AbortSignal;
  onEvent?: (event: KnoxEvent) => void;
  onLine?: (line: string) => void;
  runtime?: ContainerRuntime;
  sourceProvider?: SourceProvider;
  resultSink?: ResultSink;
}
```

No `skipPreflight`, no `promptPath` (caller reads the file), no `env` (caller
resolves auth). The engine takes resolved values and runs.

The CLI layer does the pre-container work:

```typescript
// cli/
const preflight = await PreflightChecker.check({ ... });
const image = await ImageManager.ensureSetupImage(setup);
const envVars = await resolveAuth(env);
const allowedIPs = await resolveAllowedIPs();

const result = await engine.run({
  task, dir, image, envVars, allowedIPs, ...
});
```

### 1.5 Result union (no throwing)

The engine returns a discriminated result union instead of throwing for expected
failures.

```typescript
type KnoxOutcome =
  | { ok: true; result: KnoxResult }
  | { ok: false; error: string; phase: FailurePhase; partial?: Partial<KnoxResult> };

type FailurePhase = "container" | "agent" | "bundle" | "sink";
```

- `container` — container creation or setup failed
- `agent` — agent execution failed (not timeout — that's `completed: false`)
- `bundle` — bundle extraction failed
- `sink` — result collection failed (agent work exists but wasn't collected)

The `phase` field informs retry decisions at the orchestrator level:
- `container` failure with the same inputs = don't retry
- `agent` failure = maybe retry
- `sink` failure = agent work exists, retry collection only

`partial` contains whatever result fields were populated before the failure
(e.g., `startedAt`, `loopsRun` if the agent ran before failing).

Note: `"preflight"` and `"image"` are not failure phases because preflight and
image building are no longer the engine's responsibility.

### 1.6 Source provider ref parameter

`GitSourceProvider` accepts an optional `ref` to clone a specific branch instead
of HEAD. This enables chained execution where dependent tasks start from their
parent's result branch.

```typescript
new GitSourceProvider(dir, { ref: "knox/auth-epic-f3a8b1c2" })
```

Default behavior (no ref) is unchanged — shallow clone of HEAD.

## Part 2: Queue Orchestrator

### 2.1 Queue Source Interface

The orchestrator consumes work from a `QueueSource` — an interface with injectable
implementations. The queue source is a dumb data layer; the orchestrator owns all
scheduling logic.

```typescript
interface QueueSource {
  load(): Promise<QueueManifest>;
  update(itemId: string, status: ItemStatus, outcome?: KnoxOutcome): Promise<void>;
}

type ItemStatus = "pending" | "in_progress" | "completed" | "failed" | "blocked";

interface QueueManifest {
  defaults: Partial<QueueDefaults>;
  concurrency: number;
  items: QueueItem[];
}

interface QueueDefaults {
  dir: string;
  setup: string;
  model: string;
  check: string;
  maxLoops: number;
  prompt: string;      // inline prompt or path
}

interface QueueItem {
  id: string;
  task: string;
  group?: string;
  dependsOn?: string[];
  // Per-item overrides for any default
  dir?: string;
  setup?: string;
  model?: string;
  check?: string;
  maxLoops?: number;
  prompt?: string;
}
```

MVP implementation: `FileQueueSource` — reads a local YAML file, writes state to
a separate `.state.yaml` file.

Future implementations: `GitHubIssueQueueSource`, `LinearQueueSource`,
`HTTPQueueSource`, etc.

### 2.2 Queue File Format

```yaml
# queues/auth-rewrite.yaml

concurrency: 2

defaults:
  dir: .
  setup: npm install
  model: sonnet
  check: npm test
  maxLoops: 10

items:
  - id: auth-refactor
    group: auth-epic
    task: |
      Refactor the auth middleware to use JWT tokens
      instead of session cookies. Update all route handlers
      that check authentication.
    model: opus
    maxLoops: 15

  - id: auth-tests
    group: auth-epic
    task: Add integration tests for the new JWT auth middleware
    dependsOn: [auth-refactor]

  - id: auth-validation
    group: auth-epic
    task: Add input validation to all auth endpoints
    dependsOn: [auth-tests]

  - id: license
    task: Add MIT license file

  - id: readme
    task: Update README with auth documentation
    dependsOn: [auth-refactor]
```

**Two-level config:** Queue-level `defaults` apply to all items. Per-item fields
override defaults. Only `id` and `task` are required per item.

### 2.3 Validation

All validation happens at load time, before any containers launch. Errors are
collected and reported together.

**Structural validation:**
- Required fields present (`id`, `task` per item)
- Types correct (concurrency is a positive integer, etc.)
- No duplicate item IDs

**Graph validation:**
- All `dependsOn` references point to existing item IDs
- No dependency cycles (topological sort — if it fails, reject)
- Groups form linear chains only (no diamonds — within a group, each item has at
  most one dependent in the same group)

**Error reporting:**
```
Error: Invalid queue manifest
  - Item "auth-tests" depends on "nonexistent" which does not exist
  - Cycle detected: auth-a → auth-b → auth-c → auth-a
  - Group "auth-epic" has a diamond: "auth-tests" and "auth-docs"
    both depend on "auth-refactor" within the same group
```

### 2.4 Dependency Model: DAG

Items declare dependencies via `dependsOn: [id, ...]`. The orchestrator builds a
directed acyclic graph and resolves execution order.

An item is **ready** when:
- Status is `pending`
- All items in its `dependsOn` list have status `completed`

The scheduling algorithm:
1. Find all ready items
2. Launch up to `concurrency` limit (filling empty slots)
3. When an item completes or fails, re-evaluate ready items
4. Repeat until no items are ready and no items are running

### 2.5 Concurrency

Configurable via top-level `concurrency` field. Default: `1` (serial).

The orchestrator maintains a pool of running tasks. When a slot opens (task
completes or fails), it fills it from the ready queue. Independent items across
different groups can parallelize freely.

### 2.6 Failure Handling

**Fail gracefully, no retries (MVP).**

When an item fails:
1. Mark it `failed` in the state file
2. Mark all transitive dependents `blocked`
3. Continue running independent items

The orchestrator runs everything it can, then reports:
- What completed
- What failed (and why)
- What was blocked (and by what)

### 2.7 Groups and Chained Execution

Items with the same `group` value are related and produce a single result branch.

**Constraints:**
- Items within a group must form a linear chain (enforced at validation)
- Each item in a chain starts from its predecessor's result branch (not from main)

**Execution:**
- The first item in a group chain uses `GitSourceProvider(dir)` — clones HEAD
- Subsequent items use `GitSourceProvider(dir, { ref: groupBranch })` — clones
  the group's evolving branch
- Each item's commits stack on the branch

**Branch naming:** `knox/<group>-<queueRunId>` with optional override.

Items without a `group` fork from main independently and produce their own branch
(`knox/<slug>-<runId>`).

### 2.8 Orchestrator Serializes Sink Collection

Multiple Knox runs may complete concurrently. Git operations on the host repo are
not concurrency-safe (`index.lock` conflicts). The orchestrator serializes all
`ResultSink.collect()` calls through a single serial queue, regardless of engine
concurrency.

The engine runs in parallel. Result collection is serial. This keeps the engine
simple and avoids lock contention.

### 2.9 State Persistence

**Separate state file.** The queue YAML is input (never mutated). The orchestrator
writes a `.state.yaml` file alongside it, updated on every status transition.

```
queues/
  auth-rewrite.yaml            # input (read-only)
  auth-rewrite.state.yaml      # output (written by orchestrator)
  auth-rewrite.logs/           # per-item agent output
    auth-refactor.log
    auth-tests.log
    license.log
```

State file contents:

```yaml
queueRunId: f3a8b1c2
startedAt: 2026-03-22T10:00:00Z
finishedAt: 2026-03-22T10:45:00Z

items:
  auth-refactor:
    status: completed
    runId: a1b2c3d4
    branch: knox/auth-epic-f3a8b1c2
    startedAt: 2026-03-22T10:00:00Z
    finishedAt: 2026-03-22T10:05:42Z
    durationMs: 342000

  auth-tests:
    status: completed
    runId: e5f6a7b8
    branch: knox/auth-epic-f3a8b1c2
    startedAt: 2026-03-22T10:05:43Z
    finishedAt: 2026-03-22T10:09:01Z
    durationMs: 198000

  auth-validation:
    status: failed
    runId: c9d0e1f2
    error: "Agent timeout: max loops (10) reached"
    phase: agent
    startedAt: 2026-03-22T10:09:02Z
    finishedAt: 2026-03-22T10:19:02Z
    durationMs: 600000

  license:
    status: completed
    runId: g3h4i5j6
    branch: knox/add-mit-license-g3h4i5j6
    startedAt: 2026-03-22T10:00:00Z
    finishedAt: 2026-03-22T10:00:45Z
    durationMs: 45000

  readme:
    status: blocked
    blockedBy: [auth-validation]
```

### 2.10 Resumability

**Fresh by default. `--resume` flag to continue.**

- Without `--resume`: existing state file is overwritten. All items start fresh.
- With `--resume`: orchestrator reads state file, skips `completed` items,
  re-attempts `failed` items, re-evaluates `blocked` items, starts `pending` items.
- Warning printed if state file exists and `--resume` is not passed.

### 2.11 Shared Resource Optimization

The orchestrator resolves shared resources once before launching any engine runs:

```typescript
// Orchestrator setup (once)
const preflight = await PreflightChecker.check({ ... });
const envVars = await resolveAuth(env);
const allowedIPs = await resolveAllowedIPs();

// Per unique setup command (may vary across items)
const images = new Map<string, ImageId>();
for (const setup of uniqueSetupCommands(manifest)) {
  images.set(setup, await ImageManager.ensureSetupImage(setup));
}

// Per item (parallel, up to concurrency limit)
for (const item of readyItems) {
  const image = images.get(item.setup ?? defaults.setup);
  engine.run({ ...item, image, envVars, allowedIPs });
}
```

## Part 3: CLI Changes

### 3.1 Subcommand structure

The CLI gains subcommands. Current single-task usage moves under `knox run`.

```
knox run --task "Add MIT license" --dir . --check "npm test" [...]
  # single task (current behavior, relocated under "run")

knox queue --file queues/auth-rewrite.yaml
  # fresh queue run

knox queue --file queues/auth-rewrite.yaml --resume
  # resume from state file
```

`knox run` performs pre-container setup (preflight, auth, IPs, image) then calls
the engine. Same behavior as today, restructured.

`knox queue` loads the manifest, validates, performs shared setup, then runs the
orchestrator.

### 3.2 Queue output

**Live output (stderr):**
- Default: lifecycle events only (item started, item completed/failed, progress)
- `--verbose`: interleaved agent output with item ID prefix

**Per-item log files:**
Agent output for each item is written to `<queue-name>.logs/<item-id>.log`
regardless of verbosity level.

**Final summary (stderr):**
```
Queue completed: 4/5 items succeeded, 1 failed, 0 blocked

  ✓ auth-refactor    knox/auth-epic-f3a8b1c2    5m42s
  ✓ auth-tests       knox/auth-epic-f3a8b1c2    3m18s
  ✗ auth-validation  (failed: agent timeout)     10m00s
  ✓ license          knox/add-mit-license-g3h4   0m45s
  ⊘ readme           (blocked by: auth-validation)

Branches created: 2
State file: queues/auth-rewrite.state.yaml
```

**Structured output (stdout):**
Full JSON report with all outcomes, branch names, timing, and errors.

## MVP Scope

### In scope
- Knox engine changes (run ID, abort, events, result union, dumb engine, ref param)
- Repo reorganization (`engine/`, `cli/`, `orchestrator/`, `shared/`)
- `QueueSource` interface + `FileQueueSource` (YAML)
- DAG scheduling with `dependsOn`
- Configurable concurrency (default 1)
- Fail gracefully with blocked dependents
- Explicit groups with linear chains and chained execution
- Group branches (`knox/<group>-<queueRunId>`)
- State file (separate from queue file)
- Resumability (`--resume` flag)
- CLI subcommands (`knox run`, `knox queue`)
- Per-item log files
- Lifecycle-only default output, `--verbose` for agent output

### Out of scope (future)
- PR creation (future `ResultSink` strategy)
- Notifications / completion hooks
- CI/CD integration
- Retry logic
- Diamond dependencies within groups
- Remote queue sources (GitHub Issues, Linear, HTTP)
- Remote execution

## Ubiquitous Language Additions

| Term | Meaning |
|------|---------|
| **Engine** | Knox core: container session + agent runner + source/sink. Single-task executor. Takes resolved inputs, returns `KnoxOutcome`. |
| **Orchestrator** | Queue runner: schedules engine runs based on a DAG, manages concurrency, tracks state, packages results. |
| **Queue Source** | Interface for loading queue items and persisting their status. MVP: `FileQueueSource`. |
| **Queue Manifest** | The full queue definition: defaults, concurrency, and items. Loaded from a `QueueSource`. |
| **Queue Item** | A single unit of work: task description + optional overrides, group, and dependencies. |
| **Item Status** | One of: `pending`, `in_progress`, `completed`, `failed`, `blocked`. |
| **Group** | Explicit label linking related items. Items in a group form a linear chain and produce a single branch. |
| **Chained Execution** | Dependent tasks within a group start from their predecessor's result branch, not from main. |
| **Group Branch** | `knox/<group>-<queueRunId>` — single branch with stacked commits from all items in a group. |
| **Queue Run ID** | Unique identifier for an orchestrator invocation. Used in group branch names and state file. |
| **State File** | `<queue-name>.state.yaml` — orchestrator output tracking item statuses, run IDs, branches, timing. Queue file is never mutated. |
| **Ready** | An item is ready when its status is `pending` and all dependencies are `completed`. |
| **Blocked** | An item whose dependency has `failed`. Transitively applied to all downstream dependents. |
| **KnoxOutcome** | Discriminated result union from the engine: `{ ok: true, result }` or `{ ok: false, error, phase }`. |
| **Failure Phase** | Where the engine failed: `container`, `agent`, `bundle`, or `sink`. Informs retry decisions. |
| **Lifecycle Event** | Typed event emitted by the engine via `onEvent`: loop starts, check failures, completion, abort, etc. |

## Dependency Strategy

**Category: In-process + Local-substitutable.**

- The orchestrator depends on the engine via its public interface (`KnoxEngineOptions` → `KnoxOutcome`). No new boundary abstractions needed beyond the engine's existing injectable interfaces.
- `QueueSource` is an interface. `FileQueueSource` is the MVP implementation. Tests use a mock or in-memory implementation.
- Shared utilities (`resolveAuth`, `resolveAllowedIPs`, `ImageManager`, `PreflightChecker`) remain dependency-free — they use Deno APIs directly and are testable via env vars and mocks.

## Testing Strategy

### Orchestrator tests (with mock engine)

- Loads manifest, validates, rejects invalid (missing deps, cycles, diamonds)
- Runs items in dependency order
- Respects concurrency limit
- Failed item blocks dependents, independent items continue
- Group items chain execution (source provider gets predecessor's branch ref)
- State file written on every transition
- Resume skips completed, re-attempts failed, re-evaluates blocked
- Abort signal cancels running items

### Engine tests (existing + new)

- Run ID passthrough (provided vs generated)
- Abort signal respected at loop boundary
- `onEvent` callbacks fire at correct lifecycle points
- Result union returned on failure (not thrown)
- Failure phase correctly identified

### FileQueueSource tests

- Loads valid YAML, returns manifest
- Updates state file on status change
- State file reflects current status after multiple updates
- Missing state file on resume returns all-pending

### Integration tests

- End-to-end: queue file → orchestrator → engine (mock runtime) → state file + branches
- Chained execution: second item's source provider uses first item's branch ref
