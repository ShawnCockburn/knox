# PRD 012: AgentProvider Interface Extraction

## Problem Statement

Knox's agent execution is hardcoded to Claude Code. The `AgentRunner` directly
references the Claude binary path (`/opt/claude/bin/claude`), Claude-specific
CLI flags (`-p`, `--dangerously-skip-permissions`), a sentinel string
(`KNOX_COMPLETE`) for completion detection, and Claude-specific prompt building.
This makes it impossible to swap in a different agent provider (Codex, a future
Anthropic API-based provider, etc.) without rewriting the runner.

The coupling also makes the runner hard to test — tests must mock the full
`ContainerSession` and simulate Claude CLI output rather than testing loop
orchestration in isolation.

## Solution

Extract an `AgentProvider` interface with a single `invoke` method that
encapsulates how an agent is called inside a container and how it signals
completion. The existing Claude Code logic moves into a
`ClaudeCodeAgentProvider` implementation. The `AgentRunner` becomes a
provider-agnostic loop orchestrator that receives any `AgentProvider` and drives
the retry/check/nudge cycle.

A narrow `ContainerHandle` interface replaces the full `ContainerSession`
dependency, exposing only `exec`, `execStream`, and `copyIn` — the minimal
surface an agent provider needs to interact with the container.

## User Stories

1. As a Knox maintainer, I want agent invocation decoupled from loop
   orchestration, so that I can modify one without breaking the other.
2. As a Knox maintainer, I want to add a new agent provider by implementing a
   single interface, so that supporting new agents doesn't require changes to
   the engine.
3. As a Knox user, I want to swap agent providers via configuration, so that I
   can use whichever coding agent fits my task.
4. As a Knox maintainer, I want the agent runner tested without mocking Claude
   CLI output, so that tests are fast and focused on loop behavior.
5. As a Knox maintainer, I want the Claude Code provider tested without running
   real containers, so that prompt building and sentinel detection are verified
   in isolation.
6. As a Knox maintainer, I want completion detection owned by the provider, so
   that different agents can signal "done" in whatever way suits them (sentinel
   string, structured output, exit code convention).
7. As a Knox maintainer, I want prompt building owned by the provider, so that
   each agent gets prompts formatted for its specific requirements.
8. As a Knox user, I want nudge-to-commit to work regardless of which provider I
   use, so that uncommitted agent work is always captured.
9. As a Knox maintainer, I want the container interface narrowed to what
   providers actually need, so that the contract is explicit and
   implementation-independent.
10. As a Knox maintainer, I want the model field to remain a raw string at the
    provider level, so that difficulty-based model selection can be layered on
    top without interface changes (see issue #8).

## Implementation Decisions

### New Interfaces (`AgentProvider` + `ContainerHandle`)

Both live in `src/engine/agent/agent_provider.ts`.

`ContainerHandle` exposes only:

- `exec(command, options?)` — run a command in the container
- `execStream(command, options)` — stream command output line-by-line
- `copyIn(hostPath, containerPath)` — copy a file into the container

`hasDirtyTree()` is not on `ContainerHandle`. It's a git domain concept — the
engine checks for dirty trees itself via
`exec(["git", "status", "--porcelain"])` through the handle.

`AgentProvider` has a single method:

- `invoke(ctx: AgentContext, options: InvokeOptions): Promise<InvokeResult>`

`AgentContext` carries `container: ContainerHandle`, `loopNumber`, `maxLoops`.

`InvokeOptions` carries `task`, `model`, `checkFailure?`, `customPrompt?`,
`onLine?`, `signal?`.

`InvokeResult` returns `completed: boolean`, `exitCode: number`. Completion
detection is provider-owned — the provider decides how its agent signals "done".

### No `nudge` Method

Nudge is not a separate method on `AgentProvider`. Since container state (files,
git history) persists across invocations, nudging is just another `invoke()`
call with a commit instruction as the task. The engine owns the decision to
nudge (dirty tree detected) and constructs the prompt.

### `ClaudeCodeAgentProvider` (new)

Lives at `src/engine/agent/claude_code_agent_provider.ts`. Implements
`AgentProvider`. Owns:

- `PromptBuilder` (moved from shared engine code)
- Claude binary path and CLI flags
- Sentinel string and detection
- Progress file reading (`knox-progress.txt`)
- Git log reading for prompt context
- Prompt file delivery (write to host temp file, `copyIn` to container)

### `AgentRunner` (refactored)

Stays at `src/engine/agent/agent_runner.ts`. Receives an `AgentProvider` via
constructor. Owns:

- Loop orchestration (1..maxLoops)
- Retry logic (MAX_RETRIES with exponential backoff)
- Check command execution (post-loop verification)
- Nudge decision: checks dirty tree via `exec`, calls `invoke()` with commit
  instruction, falls back to mechanical `git add -A && git commit`
- Abort signal handling at loop boundaries

### `ContainerSession` (modified)

Exposes a method to produce a `ContainerHandle` — a thin adapter over its
existing `exec`, `execStream`, and `copyIn` methods.

### `Knox` Engine (modified)

Wiring change: constructs a `ClaudeCodeAgentProvider` and passes it to
`AgentRunner`. The provider selection point is here — future work can make this
configurable.

### Model Field

`model` stays as a raw string on `InvokeOptions`. Difficulty-based model
selection (`complex | balanced | easy` mapped to concrete model names) is a
separate concern handled by the caller before invoking the provider. Tracked in
issue #8.

## Testing Decisions

Good tests in this codebase verify external behavior through public interfaces,
not implementation details. Tests mock collaborators at interface boundaries
(e.g., mock `AgentProvider` when testing `AgentRunner`, mock `ContainerHandle`
when testing `ClaudeCodeAgentProvider`).

### `AgentRunner` Tests

Mock the `AgentProvider` and `ContainerHandle`. Verify:

- Loop runs the expected number of iterations
- Stops when provider returns `completed: true`
- Retries on non-zero exit codes with backoff
- Runs check command after completion and re-loops on failure
- Nudge: detects dirty tree, calls invoke with commit instruction, falls back to
  auto-commit
- Respects abort signal

Prior art: `test/agent/agent_runner_test.ts` (will be refactored in place).

### `ClaudeCodeAgentProvider` Tests

Mock `ContainerHandle`. Verify:

- Prompt is built correctly for various inputs (task, loop context, check
  failure, custom prompt, progress file content, git log)
- Sentinel detection: returns `completed: true` when sentinel appears in output
- Prompt file is written to container at the expected path
- Model and CLI flags are passed correctly to the claude command
- Handles missing progress file gracefully

Prior art: `test/prompt/prompt_builder_test.ts` (prompt building tests will move
or be adapted).

## Out of Scope

- Difficulty-based model selection (tracked in issue #8)
- Adding a second agent provider (validates the abstraction but is separate
  work)
- Auto-difficulty classification via preprocessing LLM
- Changes to `ContainerSession` lifecycle (create, network restriction, cleanup)
- Changes to source/sink abstractions
- Daemon mode or long-running process support

## Further Notes

- The ADR (adr/001-evolve-knox-toward-platform-agnosticism.md) established the
  strategic direction. This PRD is the first concrete step.
- The `AgentProvider` abstraction is unvalidated until a second provider is
  built. Design for Claude Code's needs now; evolve the interface when the
  second provider reveals what's truly universal.
- All providers are assumed to be container-based. The `ContainerHandle` is
  passed via `AgentContext`, not constructor-injected.
