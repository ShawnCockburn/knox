# Plan: AgentProvider Interface Extraction

> Source PRD: prd/012-agent-provider-extraction.md

## Architectural decisions

Durable decisions that apply across all phases:

- **`AgentProvider` interface**: single `invoke` method — provider owns
  invocation and completion detection
- **`ContainerHandle` interface**: narrow surface (`exec`, `execStream`,
  `copyIn`) passed via `AgentContext`, not constructor-injected — all providers
  are container-based
- **Completion detection**: provider-owned — each provider decides how its agent
  signals "done" and returns `{ completed: boolean }` in the result
- **Prompt building**: provider-owned — the engine passes raw task and loop
  context, the provider formats for its agent
- **Nudge**: not a separate method — the engine calls `invoke()` with a commit
  instruction as the task
- **Dirty tree check**: engine-level — uses
  `exec(["git", "status", "--porcelain"])` through the container handle, not a
  dedicated method
- **Model field**: raw string at the provider level — difficulty mapping is out
  of scope (issue #8)
- **Interface location**: `src/engine/agent/agent_provider.ts`
- **Claude Code provider location**:
  `src/engine/agent/claude_code_agent_provider.ts`

---

## Phase 1: Define interfaces and extract `ClaudeCodeAgentProvider`

**User stories**: 1, 2, 6, 7, 9

### What to build

Define the `AgentProvider`, `ContainerHandle`, `AgentContext`, `InvokeOptions`,
and `InvokeResult` types in `src/engine/agent/agent_provider.ts`.

Create `ClaudeCodeAgentProvider` implementing `AgentProvider`. Move the
following into it from `AgentRunner`:

- Claude binary path and CLI flags (`CLAUDE_BIN`, `-p`,
  `--dangerously-skip-permissions`)
- Sentinel string and detection (`KNOX_COMPLETE`)
- `PromptBuilder` usage (and the prompt constants it depends on)
- Progress file reading (`knox-progress.txt`)
- Git log reading
- Prompt file delivery (temp file on host, `copyIn` to container)

Add a `toContainerHandle()` method (or similar) on `ContainerSession` that
returns a `ContainerHandle` — a thin adapter over its existing `exec`,
`execStream`, and `copyIn` methods.

At the end of this phase, `ClaudeCodeAgentProvider.invoke()` does exactly what
`AgentRunner.runOneLoop()` does today, but through the new interface.
`AgentRunner` still exists unchanged — it is refactored in Phase 2.

### Acceptance criteria

- [ ] `AgentProvider`, `ContainerHandle`, `AgentContext`, `InvokeOptions`,
      `InvokeResult` types are defined
- [ ] `ClaudeCodeAgentProvider` implements `AgentProvider`
- [ ] `ContainerSession` exposes a `ContainerHandle`
- [ ] `PromptBuilder`, sentinel constant, and Claude CLI constants are used only
      inside the Claude Code provider (not imported elsewhere)
- [ ] `deno check` passes — no type errors
- [ ] Existing tests pass without modification (runner is not yet refactored)

---

## Phase 2: Refactor `AgentRunner` to use `AgentProvider`

**User stories**: 1, 3, 4, 8

### What to build

Refactor `AgentRunner` to accept an `AgentProvider` and `ContainerHandle` via
its constructor instead of a `ContainerSession`. Strip all Claude-specific code
from the runner — it now calls `provider.invoke()` per loop iteration.

Changes to loop orchestration:

- `runOneLoop` calls `provider.invoke(ctx, options)` and returns the result
- Check command execution stays in the runner, using the `ContainerHandle`
  directly
- Commit nudge: runner checks dirty tree via
  `container.exec(["git", "status", "--porcelain"])`, then calls
  `provider.invoke()` with a commit instruction as the task, then falls back to
  mechanical `git add -A && git commit` if still dirty
- Retry logic (exponential backoff) stays in the runner

Wire up in `Knox` engine: construct `ClaudeCodeAgentProvider`, get
`ContainerHandle` from session, pass both to `AgentRunner`.

End-to-end behavior is identical — this is a pure refactor.

### Acceptance criteria

- [ ] `AgentRunner` constructor accepts `AgentProvider` and `ContainerHandle`
- [ ] `AgentRunner` has zero imports from prompt builder, default prompt, or
      Claude-specific constants
- [ ] `Knox` engine constructs `ClaudeCodeAgentProvider` and wires it into the
      runner
- [ ] Nudge uses `invoke()` with a commit instruction, not a hardcoded Claude
      binary call
- [ ] Dirty tree check uses `exec` on the container handle, not
      `session.hasDirtyTree()`
- [ ] `deno check` passes
- [ ] Manual smoke test: `knox run` produces identical behavior to before

---

## Phase 3: Tests for the new boundaries

**User stories**: 4, 5

### What to build

Rewrite `test/agent/agent_runner_test.ts` to test the runner against a mock
`AgentProvider` and mock `ContainerHandle`. Tests should verify loop
orchestration behavior without any Claude-specific knowledge:

- Stops when provider returns `completed: true`
- Runs up to `maxLoops` when provider never completes
- Retries on non-zero exit codes with backoff
- Runs check command after completion and re-loops on failure
- Nudge: detects dirty tree, calls invoke with commit instruction, falls back to
  auto-commit
- Respects abort signal

Create `test/agent/claude_code_agent_provider_test.ts` to test the Claude Code
provider against a mock `ContainerHandle`. Tests should verify:

- Prompt is built correctly (task, loop context, check failure, custom prompt,
  progress content, git log are all incorporated)
- Sentinel detection: returns `completed: true` when sentinel appears in
  streamed output
- Returns `completed: false` when sentinel is absent
- Prompt file is written to the expected container path
- Model and CLI flags are passed correctly in the exec command
- Handles missing progress file gracefully (no error, omitted from prompt)

Adapt or retire `test/prompt/prompt_builder_test.ts` — prompt building logic now
lives inside the provider. If `PromptBuilder` remains as an internal class, its
tests move into the provider test file.

### Acceptance criteria

- [ ] `test/agent/agent_runner_test.ts` mocks `AgentProvider`, not
      `MockRuntime`/`ContainerSession`
- [ ] `test/agent/claude_code_agent_provider_test.ts` exists and mocks
      `ContainerHandle`
- [ ] All agent runner loop behaviors are covered (completion, max loops, retry,
      check command, nudge, abort)
- [ ] All Claude Code provider behaviors are covered (prompt building, sentinel
      detection, CLI flags, error handling)
- [ ] `test/prompt/prompt_builder_test.ts` is either adapted or removed
- [ ] `deno test` passes — all tests green
