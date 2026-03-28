# Knox — Deep Module Decomposition

## Problem Statement

`Knox.run()` is a ~290-line god method that owns 6 distinct responsibilities:
auth resolution, DNS/network setup, container workspace provisioning, agent loop
execution, commit nudge, and bundle extraction. While the public API is clean
(`KnoxOptions` in, `KnoxResult` out), the implementation is a monolith where
every concern is interleaved in a single method.

This creates three concrete problems:

1. **Untestable production-critical paths.** Network restriction (iptables),
   commit nudge logic, workspace setup (chown, git verification, exclude
   configuration), and auth resolution are all untested. They can only be
   exercised by running the full pipeline, which requires mocking the entire
   orchestration just to verify one concern.

2. **Shallow abstraction.** Knox reaches through `ContainerRuntime` to execute
   raw shell commands — `runtime.exec(containerId, ["chown", "-R", ...])`,
   `runtime.exec(containerId, ["git", "status", "--porcelain"])`, inline
   iptables scripts. The orchestrator knows every implementation detail of
   container setup and git plumbing. The interface is almost as complex as the
   implementation because nothing is actually hidden.

3. **Scattered ownership.** The commit nudge (~50 lines) lives in Knox but is
   logically part of agent execution — it's the final step of "get the agent to
   produce committed work." Container path constants (`/workspace`,
   `/tmp/knox.bundle`) are duplicated between `knox.ts` and `loop_executor.ts`.
   Bundle extraction is tangled with sink delegation.

## Analysis: Why Phase Decomposition Is Insufficient

Four alternative designs were evaluated before arriving at this approach:

- **Phase functions** (extract each step as a standalone function): Creates 7-9
  small functions with growing parameter lists. Decomposes along the temporal
  axis, not the responsibility axis. Each function is shallow — it wraps 20-40
  lines but hides nothing conceptually.

- **Phase pipeline** (`Phase` interface with shared `PipelineContext`): Adds
  framework machinery (phase array, context bag, disposable cleanup) for a
  fixed, single-caller pipeline. The mutable context bag couples phases through
  shared state. No compile-time ordering guarantees.

- **Ports & adapters** (interfaces for DNS, auth, filesystem, signals, clock):
  Addresses boundary abstraction but not responsibility cohesion. 12 new files
  to wrap ~30 lines of Deno API calls. `LoopExecutor` and `ImageManager` still
  call Deno directly, making the abstraction incomplete.

- **Internal phase functions** (same public API, typed functions internally):
  Better than raw phases, but still temporal decomposition. Knox.run() becomes a
  90-line pipeline of function calls — cleaner, but still shallow.

All four decompose along the **temporal axis** (phases in a pipeline). Clean
architecture decomposes along the **responsibility axis** (objects that own
coherent behavior).

## Solution: Deep Module Collaborators

Extract two **deep modules** that own coherent responsibility clusters:

### ContainerSession

Owns the entire lifecycle of a sandboxed container — creation, workspace setup,
command execution, result extraction, and cleanup. Hides all container plumbing
(paths, chown, git verification, exclude setup, network restriction, bundle
creation) behind a small interface.

**Interface (~5 methods):**

```typescript
class ContainerSession {
  // Factory: creates container, copies source, chown, restricts network,
  // verifies .git, sets up excludes. All messy plumbing hidden.
  static async create(options: SessionOptions): Promise<ContainerSession>;

  // Run commands in the workspace
  exec(command: string[], opts?: ExecOptions): Promise<ExecResult>;
  execStream(command: string[], opts?: StreamOptions): Promise<number>;

  // Domain-level query (hides git plumbing)
  hasDirtyTree(): Promise<boolean>;

  // Extract results (hides bundle creation + copyOut)
  extractBundle(): Promise<string>;

  // Cleanup (removes container + temp files)
  dispose(): Promise<void>;
}
```

**Implementation (~150 lines) hides:**

- Container creation with correct flags (networkEnabled, capAdd, cpuLimit, etc.)
- Source copy into container + ownership fix (`chown -R knox:knox`)
- Network restriction via `runtime.restrictNetwork()`
- Git repository verification (`git rev-parse --git-dir`)
- Git exclude setup (`knox-progress.txt`, `.knox/`)
- Container path constants (`/workspace`, `/tmp/knox.bundle`)
- Bundle creation (`git bundle create`) and extraction (`copyOut`)
- Container removal and temp directory cleanup

**Dependency**: Takes `ContainerRuntime` (already an interface) via constructor.
Testable with `MockRuntime`.

### AgentRunner

Owns agent execution as a coherent operation: run loops, detect completion, and
ensure all work is committed. Absorbs the current `LoopExecutor` and the commit
nudge logic that currently lives in Knox.

```typescript
class AgentRunner {
  constructor(session: ContainerSession, config: AgentRunnerConfig);

  // Run loops + commit nudge as one coherent operation
  run(): Promise<AgentRunResult>;
}

interface AgentRunResult {
  completed: boolean;
  loopsRun: number;
  autoCommitted: boolean;
}
```

**Implementation hides:**

- Loop execution with retries (currently in `LoopExecutor`)
- Prompt building (currently in `PromptBuilder`)
- Sentinel detection (`KNOX_COMPLETE`)
- Check command verification
- Commit nudge with Claude prompt + mechanical auto-commit fallback
- Progress file and git log context gathering

**Dependency**: Takes `ContainerSession` (not `ContainerRuntime`). This means
AgentRunner never touches container plumbing — it only calls `exec()`,
`execStream()`, and `hasDirtyTree()`. Interface segregation in practice.

### Pre-container concerns: standalone functions

Auth resolution and DNS resolution are stateless, one-shot, pre-container
operations. They don't warrant their own classes:

```typescript
// Simple extracted functions — not deep modules, just cleaned-up code
async function resolveAuth(baseEnv: string[]): Promise<string[]>;
async function resolveAllowedIPs(): Promise<string[]>;
```

### Refactored Knox.run()

```typescript
async run(): Promise<KnoxResult> {
  // Pre-container setup (simple functions)
  if (!this.options.skipPreflight) await runPreflight(...);
  const image = await ensureImage(this.runtime, this.options.setup);
  const envVars = await resolveAuth(this.options.env ?? []);
  const allowedIPs = await resolveAllowedIPs();

  // Deep module: hides all container plumbing
  const session = await ContainerSession.create({
    runtime: this.runtime,
    image, runId, envVars, allowedIPs,
    sourceProvider, cpuLimit, memoryLimit,
  });

  try {
    // Deep module: hides loop execution + commit nudge
    const agentResult = await new AgentRunner(session, {
      model, task, maxLoops, checkCommand, customPrompt, onLine,
    }).run();

    // Result extraction
    const bundlePath = await session.extractBundle();
    const sinkResult = await resultSink.collect({
      runId, bundlePath, metadata, taskSlug, ...
    });

    return { ...agentResult, sink: sinkResult, ... };
  } finally {
    await session.dispose();
  }
}
```

~50 lines. Every line is a high-level operation. No shell commands, no container
paths, no git plumbing.

## SOLID Alignment

- **Single Responsibility**: ContainerSession changes when container plumbing
  changes. AgentRunner changes when execution strategy changes. Knox changes
  when the high-level flow changes.

- **Open/Closed**: Adding post-loop behaviors (lint, test runner) means
  extending AgentRunner, not modifying Knox or ContainerSession.

- **Interface Segregation**: Knox sees `ContainerSession` (5 methods), not
  `ContainerRuntime` (12+ methods). AgentRunner gets `exec`/`execStream`/
  `hasDirtyTree`, not `copyIn`/`copyOut`/`restrictNetwork`.

- **Dependency Inversion**: Knox depends on `ContainerSession` abstraction. It
  never touches Docker paths, chown, iptables, or git excludes.

## Dependency Strategy

**Category: In-process + Local-substitutable.**

- `ContainerSession` wraps `ContainerRuntime` (already an interface with
  `MockRuntime` for testing). No new boundary abstractions needed.
- `AgentRunner` depends on `ContainerSession`, which can be mocked or stubbed in
  tests without `MockRuntime`.
- Pre-container functions (`resolveAuth`, `resolveAllowedIPs`) use Deno APIs
  directly. These remain local-substitutable via env vars and DNS mocking in
  integration tests, or can be made injectable later if test friction warrants.

## Testing Strategy

### New boundary tests to write

**ContainerSession tests** (with MockRuntime):

- `create()` calls createContainer, copyIn, chown, restrictNetwork, git verify,
  and excludes in the correct order
- `create()` throws if git verification fails
- `hasDirtyTree()` returns true/false based on `git status --porcelain`
- `extractBundle()` creates bundle and copies to host path
- `dispose()` removes container and cleans up temp directory
- `dispose()` is safe to call twice (idempotent)

**AgentRunner tests** (with mock ContainerSession):

- Runs loops up to maxLoops, detects KNOX_COMPLETE sentinel
- Check command failure triggers additional loop with failure context
- Dirty tree after loops triggers nudge via execStream
- Nudge failure falls back to mechanical auto-commit
- Clean tree after loops skips nudge entirely
- Returns accurate `{ completed, loopsRun, autoCommitted }`

**resolveAuth tests**:

- Returns OAuth token when credential is available
- Falls back to ANTHROPIC_API_KEY from env
- Returns base env unchanged when no credential available

**resolveAllowedIPs tests**:

- Returns resolved IPs from DNS
- Falls back to dig when Deno.resolveDns fails
- Throws when no IPs can be resolved

### Old tests to replace

- `test/knox_test.ts` — the 7 existing tests mock everything and verify wiring.
  These stay but become thinner: they test Knox's composition of
  ContainerSession + AgentRunner + ResultSink, not the internal plumbing.

- `test/loop/loop_executor_test.ts` — the 6 existing tests move to AgentRunner
  tests since AgentRunner absorbs LoopExecutor. The loop execution behavior
  tests remain; the commit nudge tests that currently live in `knox_test.ts`
  move here.

### Test environment needs

No new test infrastructure. `MockRuntime` (already exists) is sufficient for
ContainerSession tests. AgentRunner tests need a mock ContainerSession, which is
a simple stub implementing 5 methods.

## Implementation Recommendations

### What ContainerSession should own

- All container lifecycle: creation, configuration, execution, extraction,
  cleanup
- Container path constants (single source of truth)
- Git plumbing inside the container (verify, exclude, bundle)
- Source copy and ownership setup
- Network restriction

### What ContainerSession should hide

- Container paths (`/workspace`, `/tmp/knox.bundle`)
- Ownership commands (`chown -R knox:knox`)
- Git exclude setup (`printf ... >> .git/info/exclude`)
- Network restriction details
- Bundle creation mechanics

### What ContainerSession should expose

- `create()` — factory that handles all setup
- `exec()` / `execStream()` — run commands in the workspace
- `hasDirtyTree()` — domain query
- `extractBundle()` — result extraction
- `dispose()` — cleanup

### What AgentRunner should own

- Loop execution with retries
- Prompt building and context gathering
- Sentinel detection
- Check command verification
- Commit nudge (nudge prompt + auto-commit fallback)

### What AgentRunner should hide

- Retry logic and backoff
- Prompt assembly (delegates to PromptBuilder internally)
- Progress file reading
- Git log gathering
- Nudge prompt content and fallback mechanics

### What AgentRunner should expose

- `run()` returning `{ completed, loopsRun, autoCommitted }`

### Migration path

1. Extract `ContainerSession` with `create()` and `dispose()`. Move container
   setup code from Knox.run() into `ContainerSession.create()`. Update Knox to
   use the session. Existing tests should pass unchanged.

2. Add `exec()`, `execStream()`, `hasDirtyTree()`, `extractBundle()` to
   ContainerSession. Migrate Knox's post-loop code to use these methods.

3. Extract `AgentRunner`. Move LoopExecutor's logic + commit nudge into
   AgentRunner. AgentRunner takes ContainerSession instead of ContainerRuntime.

4. Extract `resolveAuth()` and `resolveAllowedIPs()` as standalone functions.

5. Write boundary tests for ContainerSession and AgentRunner. Remove redundant
   shallow tests from knox_test.ts.

6. Delete LoopExecutor (absorbed into AgentRunner) and its test file. Move
   relevant test cases to AgentRunner tests.

## File Layout

```
src/
  knox.ts                          # Thin coordinator (~50 lines in run())
  session/
    container_session.ts           # Deep module: container lifecycle (~150 lines)
    mod.ts                         # Public re-export
  agent/
    agent_runner.ts                # Deep module: loop execution + nudge (~150 lines)
    mod.ts                         # Public re-export
  knox/
    resolve_auth.ts                # Standalone function (~25 lines)
    resolve_network.ts             # Standalone function (~35 lines)
  prompt/                          # Unchanged (used internally by AgentRunner)
  image/                           # Unchanged
  preflight/                       # Unchanged
  source/                          # Unchanged
  sink/                            # Unchanged
  runtime/                         # Unchanged
  auth/                            # Unchanged (used by resolve_auth)

test/
  session/
    container_session_test.ts      # Boundary tests with MockRuntime
  agent/
    agent_runner_test.ts           # Boundary tests with mock ContainerSession
  knox/
    resolve_auth_test.ts           # Unit tests
    resolve_network_test.ts        # Unit tests
  knox_test.ts                     # Slimmed: wiring/composition tests only
```
