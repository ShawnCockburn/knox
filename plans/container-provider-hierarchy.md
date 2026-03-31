# Plan: ContainerProvider Hierarchy and ShellExecutor

> Source PRD: prd/013-container-provider-hierarchy.md

## Architectural decisions

Durable decisions that apply across all phases:

- **Type hierarchy**: `ContainerContext` (base) → `ShellContext` / `LlmAgentContext`. `ContainerContext` holds `container: ContainerHandle` and `onLine?`. Children add their domain-specific fields.
- **Provider hierarchy**: `ContainerProvider<TContext extends ContainerContext>` (generic root) → `AgentProvider<T extends LlmAgentContext>` (LLM tier, marker interface) / `ShellProvider` (shell tier). `AgentProvider` extends `ContainerProvider`, adding no new methods.
- **Runners**: `AgentRunner` requires `AgentProvider` (LLM loop). `ShellExecutor` requires `ContainerProvider<ShellContext>` (single invoke).
- **Return type**: `InvokeResult = { completed: boolean, exitCode: number }` — shared by both tiers.
- **Container boundary**: `ContainerHandle` interface is unchanged — `exec`, `execStream`, `copyIn`.
- **Wiring**: Direct construction. No factory or registry.

---

## Phase 1: Refactor type hierarchy

**User stories**: 1, 4, 5, 6, 11, 12

### What to build

A pure structural refactor of the existing agent types with no new behavior. Split the current `AgentContext` into three types: `ContainerContext` (base with `container` and `onLine`), `ShellContext` (adds `command`), and `LlmAgentContext` (adds `task`, `loopNumber`, `maxLoops`, `checkFailure?`, `customPrompt?`).

Rename the current `AgentProvider` interface to `ContainerProvider<TContext extends ContainerContext>` — the generic root. Introduce `AgentProvider<T extends LlmAgentContext>` as a marker interface extending `ContainerProvider` that narrows the generic bound to LLM-specific context.

Update `ClaudeCodeAgentProvider` to implement `AgentProvider<LlmAgentContext>`. Update `AgentRunner` to require `AgentProvider<LlmAgentContext>`. Update the Knox engine's provider construction and all type references. Update `mod.ts` exports. Update existing tests for new type names.

After this phase, the codebase compiles, all existing tests pass, and runtime behavior is identical — only the type names and hierarchy have changed.

### Acceptance criteria

- [ ] `ContainerContext`, `ShellContext`, and `LlmAgentContext` types exist with correct inheritance
- [ ] `ContainerProvider<TContext>` generic interface exists with `invoke(ctx: TContext): Promise<InvokeResult>`
- [ ] `AgentProvider<T extends LlmAgentContext>` extends `ContainerProvider<T>` with no additional methods
- [ ] `ClaudeCodeAgentProvider` implements `AgentProvider<LlmAgentContext>`
- [ ] `AgentRunner` constructor requires `AgentProvider<LlmAgentContext>` (not the base `ContainerProvider`)
- [ ] Knox engine compiles with updated type references
- [ ] `mod.ts` exports the new types and removes the old names
- [ ] All existing tests in `agent_runner_test.ts` pass
- [ ] All existing tests in `claude_code_agent_provider_test.ts` pass
- [ ] `deno task check` passes (full type check)
- [ ] `deno task test:unit` passes
- [ ] `deno task fmt` and `deno task lint` pass

---

## Phase 2: ShellProvider and ShellExecutor

**User stories**: 2, 3, 7, 10

### What to build

Two new modules that complete the shell branch of the provider hierarchy.

`ShellProvider` implements `ContainerProvider<ShellContext>`. Its `invoke` method runs `sh -c ${command}` in the container via `execStream`, forwards output through the `onLine` callback, and returns `{ completed: exitCode === 0, exitCode }`.

`ShellExecutor` is the orchestration counterpart to `AgentRunner` for shell jobs. It takes a `ContainerProvider<ShellContext>`, a `ContainerHandle`, and a command string. It invokes the provider exactly once and returns the result. No loop, no retry, no check command, no commit nudge.

Unit tests for both modules use mock `ContainerHandle` instances (same pattern as existing `claude_code_agent_provider_test.ts`). Tests verify: command passed correctly to `sh -c`, exit code mapping, `onLine` streaming, single invocation (no loop), and result forwarding.

### Acceptance criteria

- [ ] `ShellProvider` implements `ContainerProvider<ShellContext>`
- [ ] `ShellProvider.invoke` runs the command via `sh -c` and streams output through `onLine`
- [ ] `ShellProvider.invoke` returns `completed: true` on exit code 0, `completed: false` otherwise
- [ ] `ShellExecutor` invokes the provider exactly once (verified by test)
- [ ] `ShellExecutor` returns the `InvokeResult` from the provider without modification
- [ ] Unit test: command string is passed to container as `["sh", "-c", command]`
- [ ] Unit test: non-zero exit code produces `completed: false`
- [ ] Unit test: `onLine` callback receives stdout lines
- [ ] Unit test: `ShellExecutor` does not loop, retry, or commit-nudge
- [ ] New types exported from `mod.ts`
- [ ] `deno task check`, `deno task test:unit`, `deno task fmt`, `deno task lint` all pass

---

## Phase 3: Integration smoke test

**User stories**: 8

### What to build

An end-to-end integration test that validates the shell tier against a real Docker container. The test creates a container from the Knox base image via `DockerRuntime`, wraps it in a `ContainerHandle`, wires up `ShellProvider` + `ShellExecutor`, runs `echo hello` as the command, and asserts `completed: true` with exit code 0.

A second test case runs a command that exits non-zero (e.g., `exit 1`) and asserts `completed: false`.

This test lives alongside the existing `docker_runtime_test.ts` integration tests and requires Docker to be running.

### Acceptance criteria

- [ ] Integration test creates a real container, runs `echo hello` via `ShellExecutor` + `ShellProvider`, asserts `completed: true`
- [ ] Integration test runs a failing command, asserts `completed: false`
- [ ] `onLine` callback receives the expected output (`hello`)
- [ ] Container is cleaned up after the test
- [ ] `deno task test:integration` passes
