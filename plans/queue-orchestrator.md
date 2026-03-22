# Plan: Queue Orchestrator

> Source PRD: prd/005-queue-orchestrator.md (Part 2)
>
> Prerequisite: plans/repo-restructure.md must be complete. The orchestrator depends on the engine's `KnoxOutcome` return type, `AbortSignal` support, `onEvent` callbacks, `runId` passthrough, and `GitSourceProvider` ref parameter.

## Architectural decisions

Durable decisions that apply across all phases:

- **QueueSource interface**: `load(): Promise<QueueManifest>` + `update(itemId, status, outcome?)`. Dumb data layer — orchestrator owns all scheduling logic.
- **State separation**: Queue YAML is read-only input. State persisted to a separate `.state.yaml` file, updated on every status transition.
- **Item statuses**: `pending`, `in_progress`, `completed`, `failed`, `blocked`.
- **Dependency model**: DAG with `dependsOn`. An item is ready when all dependencies are `completed`.
- **Failure policy**: Fail gracefully — failed items block dependents, independent items continue. No retries in MVP.
- **Group model**: Explicit `group` key. Items within a group form a linear chain (no diamonds, validated at load). Group produces single branch with stacked commits.
- **Chained execution**: Dependent items within a group start from predecessor's result branch via `GitSourceProvider({ ref })`.
- **Concurrency**: Configurable `concurrency: N`, default 1. Sink collection serialized regardless of engine concurrency.
- **Branch naming**: Groups: `knox/<group>-<queueRunId>`. Ungrouped: `knox/<slug>-<runId>`.
- **Resumability**: Fresh by default. `--resume` flag reads existing state file.
- **Output**: Lifecycle events to stderr (default), agent output with `--verbose`. Per-item log files always. JSON on stdout at completion.

---

## Phase 1: QueueSource interface + FileQueueSource + validation

**Goal**: Define the queue data layer and implement the YAML-based MVP with thorough upfront validation.

### What to build

Define the `QueueSource` interface with `load()` and `update()` methods. Define `QueueManifest`, `QueueItem`, `QueueDefaults`, and `ItemStatus` types.

Implement `FileQueueSource`:
- `load()` reads a YAML file, parses it, validates it, and returns a `QueueManifest`
- `update()` writes status changes to a separate `.state.yaml` file alongside the queue file

Validation runs at load time and collects all errors before reporting:
- **Structural**: required fields (`id`, `task`), types, no duplicate IDs, concurrency is positive integer
- **Referential**: all `dependsOn` entries reference existing item IDs
- **Cycle detection**: topological sort — reject if cycles found
- **Group linearity**: within a group, each item has at most one dependent in the same group (no diamonds)

Return collected errors in a structured format so callers can report them all at once.

### Acceptance criteria

- [ ] `QueueSource` interface defined with `load()` and `update()`
- [ ] `FileQueueSource` reads YAML and returns typed `QueueManifest`
- [ ] Two-level config: queue-level `defaults` merge with per-item overrides
- [ ] Validation rejects missing `id` or `task` with clear error message
- [ ] Validation rejects duplicate item IDs
- [ ] Validation rejects dangling `dependsOn` references
- [ ] Validation rejects cycles with the cycle path in the error message
- [ ] Validation rejects diamonds within a group
- [ ] All validation errors collected and reported together (not one-at-a-time)
- [ ] `update()` writes to `.state.yaml`, never mutates the queue YAML
- [ ] Tests cover all validation cases (valid manifests, each error type)

---

## Phase 2: Serial execution (no dependencies, no groups)

**Goal**: Orchestrator runs items one at a time, tracks state, writes logs, and produces a final report. Dependencies and groups are ignored — every item forks from main.

### What to build

Implement the core orchestrator loop:
1. Load manifest via `QueueSource.load()`
2. Resolve shared resources once (auth, IPs, images)
3. For each item (in declaration order):
   - Mark `in_progress` via `QueueSource.update()`
   - Create engine options (merge defaults + item overrides)
   - Call engine, capture `KnoxOutcome`
   - Write agent output to per-item log file (`<queue-name>.logs/<item-id>.log`)
   - Mark `completed` or `failed` via `QueueSource.update()`
4. Print final summary to stderr
5. Print JSON report to stdout

State file is updated on every transition so it reflects current progress at all times.

Per-item log files are written to a `<queue-name>.logs/` directory alongside the queue file. Agent output is captured via the engine's `onLine` callback.

### Acceptance criteria

- [ ] Orchestrator loads manifest and runs each item serially
- [ ] Shared resources (auth, IPs, images) resolved once before any items run
- [ ] State file updated on every status transition (in_progress, completed, failed)
- [ ] Per-item log file captures full agent output
- [ ] Final stderr summary shows each item's status, branch, and duration
- [ ] Final stdout is valid JSON with all outcomes
- [ ] Failed item does not crash orchestrator — remaining items still run
- [ ] State file is a complete record of the run when orchestrator finishes
- [ ] End-to-end test with mock engine: queue file in → state file + logs out

---

## Phase 3: DAG scheduling + failure handling

**Goal**: Items run in dependency order. Failed items block their dependents. Independent items continue.

### What to build

Replace the serial "run each item in order" loop with a DAG-aware scheduler:

1. Build dependency graph from `dependsOn` declarations
2. Find all **ready** items (pending + all dependencies completed)
3. Pick one ready item (concurrency is still 1 in this phase), run it
4. On completion: re-evaluate ready items
5. On failure: mark item `failed`, transitively mark all downstream dependents `blocked`, re-evaluate ready items
6. Loop until no items are ready and no items are running

The scheduler replaces the serial loop but uses the same engine invocation, state tracking, and reporting from phase 2.

### Acceptance criteria

- [ ] Items with no dependencies run first
- [ ] Items with satisfied dependencies run after their dependencies complete
- [ ] Items with unsatisfied dependencies wait
- [ ] Failed item causes all transitive dependents to be marked `blocked`
- [ ] `blocked` items include `blockedBy` field in state file listing the failed dependency
- [ ] Independent items (no dependency path to failed item) continue running
- [ ] Final report distinguishes completed, failed, and blocked items
- [ ] Test: diamond-shaped DAG (A → B, A → C, B+C → D) — if B fails, D is blocked, C continues
- [ ] Test: linear chain (A → B → C) — if A fails, B and C are blocked
- [ ] Test: all independent items — all run regardless of individual failures

---

## Phase 4: Configurable concurrency

**Goal**: Multiple items run in parallel up to a configurable limit.

### What to build

Add a concurrency pool to the scheduler. The pool maintains up to `concurrency` running items simultaneously. When a slot opens (item completes or fails), the scheduler fills it from the ready queue.

Sink collection (writing branches to the host repo) is serialized through a queue regardless of engine concurrency. Engines run in parallel; results are collected serially to avoid git lock contention.

The `concurrency` field comes from the queue manifest (default: 1).

### Acceptance criteria

- [ ] `concurrency: 1` behaves identically to phase 3 (serial)
- [ ] `concurrency: N` runs up to N items simultaneously
- [ ] Ready items fill empty slots as running items complete
- [ ] Sink collection is serialized — no concurrent `git fetch` on host repo
- [ ] Failure handling unchanged — blocked items still propagate correctly under concurrency
- [ ] Test: 3 independent items with `concurrency: 2` — first 2 run in parallel, third starts when one finishes
- [ ] Test: dependent items respect ordering even with available concurrency slots
- [ ] `AbortSignal` cancels all running items on abort

---

## Phase 5: Groups + chained execution

**Goal**: Grouped items form linear chains, produce a single branch with stacked commits, and each item builds on its predecessor's output.

### What to build

When the orchestrator encounters an item with a `group`:
- First item in the chain: uses default `GitSourceProvider(dir)` — forks from HEAD
- Subsequent items: uses `GitSourceProvider(dir, { ref: groupBranch })` — forks from the group's evolving branch
- The sink writes to the group branch: `knox/<group>-<queueRunId>`

The orchestrator tracks group state — which branch each group is building on. After each item in a chain completes and its result is collected to the group branch, the next item's source provider is wired to that branch.

Ungrouped items continue to fork from main and produce individual branches.

Group branch naming: `knox/<group>-<queueRunId>` by default. Items within a group share the same branch — commits stack.

### Acceptance criteria

- [ ] Items with the same `group` produce a single branch
- [ ] First item in chain clones from HEAD
- [ ] Subsequent items clone from the group's result branch (predecessor's output)
- [ ] Commits from all items in the chain are stacked on the group branch
- [ ] Group branch named `knox/<group>-<queueRunId>`
- [ ] Ungrouped items produce individual branches (unchanged from prior phases)
- [ ] If an item in a chain fails, subsequent chain items are blocked
- [ ] Test: 3-item chain produces one branch with 3+ commits
- [ ] Test: mixed grouped and ungrouped items produce correct branches

---

## Phase 6: Resumability

**Goal**: `--resume` flag allows continuing a previous run from where it left off.

### What to build

When `--resume` is passed:
1. Load the existing state file
2. Skip items with status `completed`
3. Re-attempt items with status `failed` (reset to `pending`)
4. Re-evaluate items with status `blocked` — if their dependencies are now all `completed`, they become `pending`
5. Start items with status `pending`

When `--resume` is not passed and a state file exists: print a warning ("State file exists from a previous run. Use --resume to continue, or it will be overwritten."), then overwrite.

For grouped items being resumed: the source provider must use the group branch from the previous run (recorded in state file) so new items chain correctly onto existing commits.

### Acceptance criteria

- [ ] Without `--resume`: fresh run, state file overwritten if it exists
- [ ] Warning printed when state file exists and `--resume` not passed
- [ ] `--resume` skips `completed` items
- [ ] `--resume` re-attempts `failed` items
- [ ] `--resume` re-evaluates `blocked` items based on current dependency state
- [ ] Resumed group chains pick up from the existing group branch
- [ ] State file's `queueRunId` is preserved on resume (same run continues)
- [ ] Test: run with 2/5 completed, resume completes remaining 3
- [ ] Test: resume with failed item in a chain — re-run failed, then unblock dependents

---

## Phase 7: Wire into CLI

**Goal**: `knox queue` subcommand invokes the orchestrator with proper output handling.

### What to build

Connect the `knox queue` placeholder (from repo-restructure plan, phase 6) to the orchestrator:

- `knox queue --file <path>` — load manifest, validate, run orchestrator
- `knox queue --file <path> --resume` — resume from state file
- `--verbose` — show interleaved agent output with `[item-id]` prefix
- Default (no `--verbose`) — show lifecycle events only (item started, completed, failed, progress)

Output routing:
- Lifecycle events → stderr (always)
- Agent output → stderr only with `--verbose`, prefixed with `[item-id]`
- Agent output → per-item log file (always, regardless of verbosity)
- Final summary → stderr
- Final JSON report → stdout

Shared resource optimization:
- Resolve auth, allowed IPs once
- Build/check images once per unique setup command across all items
- Pass resolved values to each engine invocation

Exit codes:
- 0: all items completed
- 1: some items failed or blocked
- 2: validation failure (bad manifest)
- 3: orchestrator crash

### Acceptance criteria

- [ ] `knox queue --file <path>` runs the orchestrator end-to-end
- [ ] `knox queue --file <path> --resume` resumes from state file
- [ ] Default output shows lifecycle events only (item started/completed/failed)
- [ ] `--verbose` shows agent output with `[item-id]` prefix
- [ ] Per-item log files written regardless of verbosity
- [ ] Final summary on stderr shows all items with status, branch, duration
- [ ] Final JSON on stdout is valid and complete
- [ ] Auth, IPs, and images resolved once for the entire queue run
- [ ] Exit code 0 when all items succeed, 1 when any fail/blocked, 2 on bad manifest
- [ ] Ctrl+C aborts all running items via AbortSignal, prints partial summary
