# Plan: Knox Deep Module Decomposition

> Source PRD: prd/004-knox-decomposition.md

## Architectural decisions

Durable decisions that apply across all phases:

- **Public API**: `Knox` class, `KnoxOptions`, and `KnoxResult` interfaces are
  unchanged throughout all phases. No caller migration required.
- **ContainerSession**: A class with a static `create()` factory and instance
  methods. Lives in `src/session/`. Takes `ContainerRuntime` via constructor —
  testable with existing `MockRuntime`.
- **AgentRunner**: A class taking `ContainerSession` via constructor. Lives in
  `src/agent/`. Never touches `ContainerRuntime` directly — interface
  segregation enforced by design.
- **Pre-container functions**: Standalone exported functions (`resolveAuth`,
  `resolveAllowedIPs`), not classes. Live in `src/knox/`.
- **Path constants**: `/workspace`, `/tmp/knox.bundle`, and all
  container-internal paths are owned solely by `ContainerSession` as private
  constants. No other module defines or references these paths.
- **Test strategy**: Boundary tests at each new module's interface. Existing
  `knox_test.ts` passes green at every phase. Old tests are migrated or removed
  only after replacement boundary tests exist.
- **Module re-exports**: Each new directory (`session/`, `agent/`, `knox/`) has
  a `mod.ts` barrel file following the existing codebase pattern.

---

## Phase 1: ContainerSession — create() and dispose()

**User stories**: Container lifecycle ownership, workspace setup encapsulation,
cleanup safety

### What to build

The tracer bullet. Extract a `ContainerSession` class that owns the entire
"create a sandboxed container and tear it down" flow.
`ContainerSession.create()` absorbs all the container setup code currently
inline in `Knox.run()`: creating the container with correct flags, copying
source into the workspace, fixing ownership with chown, restricting network to
API-only egress, verifying `.git` exists, and setting up git excludes.
`dispose()` absorbs container removal.

Knox.run() changes to: call `ContainerSession.create()`, use the returned
session's `containerId` for subsequent operations, and call `session.dispose()`
in the `finally` block. At this phase, Knox still reaches through
`session.containerId` and `this.runtime` for post-loop operations — that
coupling is removed in Phase 2.

Write boundary tests for ContainerSession that verify the setup sequence (create
→ copyIn → chown → restrictNetwork → git verify → excludes) and cleanup behavior
(dispose is idempotent, dispose removes container).

### Acceptance criteria

- [ ] `ContainerSession.create()` encapsulates container creation, source copy,
      chown, network restriction, git verification, and exclude setup
- [ ] `ContainerSession.dispose()` removes the container and is safe to call
      twice
- [ ] Container path constants (`/workspace`) are defined in ContainerSession,
      not Knox
- [ ] Knox.run() uses `ContainerSession.create()` and `session.dispose()` — no
      direct container creation or cleanup code remains in Knox
- [ ] Source provider `.prepare()` and `.cleanup()` are called by
      ContainerSession.create(), not Knox
- [ ] Boundary tests verify the setup call sequence using MockRuntime
- [ ] Boundary test verifies that create() throws when git verification fails
- [ ] All existing `knox_test.ts` tests pass without modification
- [ ] All existing tests across the project pass (`deno test`)

---

## Phase 2: ContainerSession — exec, query, and extraction methods

**User stories**: Container plumbing abstraction, bundle extraction
encapsulation

### What to build

Add `exec()`, `execStream()`, `hasDirtyTree()`, and `extractBundle()` to
ContainerSession. These methods scope the runtime calls to the session's
container and workspace — callers pass commands without knowing container paths
or IDs.

`hasDirtyTree()` encapsulates the `git status --porcelain` check.
`extractBundle()` encapsulates `git bundle create` inside the container,
`copyOut` to the host run directory, and returns the host-side bundle path.

Migrate Knox's post-loop code to use session methods: the commit nudge
dirty-check uses `session.hasDirtyTree()`, bundle creation uses
`session.extractBundle()`, and any remaining `runtime.exec(containerId, ...)`
calls go through `session.exec()`.

After this phase, Knox no longer holds a reference to `ContainerRuntime` for
post-creation operations. It only uses `ContainerSession` methods.

### Acceptance criteria

- [ ] `session.exec()` and `session.execStream()` delegate to runtime with the
      session's containerId and workspace
- [ ] `session.hasDirtyTree()` returns boolean based on `git status --porcelain`
      output
- [ ] `session.extractBundle()` creates bundle in container, copies to host,
      returns host path
- [ ] Knox.run() post-loop code uses session methods instead of
      `this.runtime.exec(containerId, ...)`
- [ ] Knox.run() no longer passes `containerId` to any code outside of
      ContainerSession
- [ ] Boundary tests for hasDirtyTree() with clean and dirty workspace states
- [ ] Boundary tests for extractBundle() verifying bundle create + copyOut
      sequence
- [ ] Boundary test for extractBundle() failure (non-zero exit from git bundle)
- [ ] All existing tests pass (`deno test`)

---

## Phase 3: AgentRunner — absorb LoopExecutor

**User stories**: Agent execution cohesion, loop management encapsulation

### What to build

Create an `AgentRunner` class that takes a `ContainerSession` (not
`ContainerRuntime`) and owns the loop execution lifecycle. Move LoopExecutor's
loop iteration, retry with exponential backoff, sentinel detection, prompt
building, progress file reading, git log gathering, and check command
verification into AgentRunner.

AgentRunner uses `session.exec()` and `session.execStream()` for all container
interactions. It never sees `ContainerRuntime` or `containerId` — interface
segregation enforced structurally.

Knox.run() changes from constructing a `LoopExecutor` to constructing an
`AgentRunner`. The return type at this phase is `{ completed, loopsRun }`
(commit nudge is still in Knox — that moves in Phase 4).

Delete `src/loop/loop_executor.ts` and `src/loop/mod.ts`. Migrate the 6 existing
LoopExecutor tests to AgentRunner tests, adapting them to use a mock
ContainerSession instead of MockRuntime.

### Acceptance criteria

- [ ] AgentRunner constructor takes ContainerSession, not ContainerRuntime
- [ ] AgentRunner.run() returns `{ completed: boolean, loopsRun: number }`
- [ ] Loop iteration, retry/backoff, sentinel detection, and check command logic
      moved from LoopExecutor to AgentRunner
- [ ] Prompt building and context gathering (progress file, git log) use
      session.exec()
- [ ] Knox.run() constructs AgentRunner with the session and delegates loop
      execution
- [ ] LoopExecutor files deleted (`src/loop/loop_executor.ts`,
      `src/loop/mod.ts`)
- [ ] All 6 LoopExecutor test cases migrated to AgentRunner tests
- [ ] AgentRunner tests use a mock/stub ContainerSession, not MockRuntime
- [ ] All existing knox_test.ts tests pass (may need minor mock adjustments)
- [ ] All tests pass (`deno test`)

---

## Phase 4: AgentRunner — absorb commit nudge

**User stories**: Commit recovery cohesion, agent execution as single
responsibility

### What to build

Move the commit nudge logic (dirty-tree check, Claude nudge prompt, auto-commit
fallback) from Knox.run() into AgentRunner.run(). This completes the "get the
agent to produce committed work" responsibility — loop execution and commit
recovery are now one coherent operation.

AgentRunner.run() return type expands to
`{ completed, loopsRun, autoCommitted }`. Knox.run() no longer contains any
agent execution or commit recovery logic — it calls `agentRunner.run()` and uses
the result directly.

Write boundary tests for the nudge flow: clean tree skips nudge, dirty tree
triggers nudge via execStream, failed nudge falls back to auto-commit,
successful nudge returns autoCommitted=false. The existing nudge tests in
knox_test.ts are replaced by these more focused AgentRunner tests.

After this phase, Knox.run() should be ~50 lines — a thin coordinator calling
create session, run agent, extract bundle, collect sink, return result.

### Acceptance criteria

- [ ] Commit nudge logic (dirty check, nudge prompt, auto-commit fallback)
      removed from Knox.run()
- [ ] AgentRunner.run() returns `{ completed, loopsRun, autoCommitted }`
- [ ] AgentRunner uses `session.hasDirtyTree()` for the dirty check
- [ ] AgentRunner uses `session.execStream()` for the nudge Claude invocation
- [ ] AgentRunner uses `session.exec()` for the mechanical auto-commit
- [ ] Knox.run() is ~50 lines with no shell commands, container paths, or git
      plumbing
- [ ] Boundary tests: clean tree skips nudge entirely
- [ ] Boundary tests: dirty tree triggers nudge, successful nudge returns
      autoCommitted=false
- [ ] Boundary tests: failed nudge falls back to auto-commit, returns
      autoCommitted=true
- [ ] Commit nudge tests in knox_test.ts simplified or removed (replaced by
      AgentRunner tests)
- [ ] All tests pass (`deno test`)

---

## Phase 5: Extract pre-container functions

**User stories**: Auth resolution testability, network resolution testability

### What to build

Extract `resolveAuth()` and `resolveAllowedIPs()` from Knox.run() as standalone
exported functions. These are stateless, one-shot, pre-container operations that
don't warrant their own classes but benefit from independent testing.

`resolveAuth(baseEnv: string[])` encapsulates the OAuth-then-API-key fallback
chain and returns the augmented env var array. `resolveAllowedIPs()`
encapsulates DNS resolution with dig fallback and returns the IP list.

Knox.run() calls these functions instead of inline code. Write unit tests for
each: auth with OAuth available, auth with API key fallback, auth with no
credential; DNS resolution success, DNS with dig fallback, DNS failure throws.

### Acceptance criteria

- [ ] `resolveAuth()` exported from `src/knox/resolve_auth.ts`
- [ ] `resolveAuth()` tries OAuth credential, falls back to ANTHROPIC_API_KEY,
      returns augmented env array
- [ ] `resolveAllowedIPs()` exported from `src/knox/resolve_network.ts`
- [ ] `resolveAllowedIPs()` resolves DNS for API hosts with dig fallback, throws
      on zero results
- [ ] Knox.run() calls these functions instead of inline auth/network code
- [ ] Unit tests for resolveAuth: OAuth success, API key fallback, no credential
      available
- [ ] Unit tests for resolveAllowedIPs: DNS success, dig fallback, zero-results
      error
- [ ] Knox.run() no longer imports `getCredential` or `CredentialError` directly
- [ ] Knox.run() no longer contains DNS resolution or dig fallback logic
- [ ] All tests pass (`deno test`)
