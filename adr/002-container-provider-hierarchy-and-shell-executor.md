# Introduce ContainerProvider hierarchy and ShellExecutor

## Status

**Accepted**

## Context

ADR 001 introduced the `AgentProvider` interface and
`ClaudeCodeAgentProvider` as the first implementation. The ADR noted that
the abstraction is "unvalidated until a second provider is built."

Simultaneously, Knox needed a way to run one-shot container jobs (PR
summary generation, utility scripts) without the LLM loop machinery
(sentinel detection, check commands, re-prompting). PRD 011 had proposed
a separate `UtilityContainer` abstraction, but that design predated the
`AgentProvider` extraction and would duplicate container lifecycle
management.

The question: how should Knox support both autonomous LLM agents (loop,
sentinel, check) and simple shell jobs (single command, exit code) within
a single provider model?

## Decision Tree

1. **Single flat interface, ignore irrelevant fields** — `ShellProvider`
   receives the full `AgentContext` (including `loopNumber`, `maxLoops`,
   etc.), ignores what it doesn't need, returns `completed: true` on
   first invoke.
   - *Tradeoffs:* Zero interface changes. But the context carries dead
     fields for shell jobs, and the type system can't distinguish which
     provider needs what.
   - *Verdict:* Rejected — the caller shouldn't need to populate fields
     the provider ignores. The type system should enforce correctness.

2. **Two-tier with LlmAgentProvider extending AgentProvider** — base
   `AgentProvider` takes `command: string`, `LlmAgentProvider` extends
   with loop-aware fields (`task`, `loopNumber`, etc.).
   - *Tradeoffs:* Clean tier separation. But violates Liskov — the LLM
     tier inherits a `command` field that's meaningless to it. An
     `LlmAgentProvider` can't substitute where an `AgentProvider` is
     expected because the caller would set `command` and the provider
     would ignore it.
   - *Verdict:* Rejected — the extends relationship is misleading when
     the subtype doesn't honor the inherited contract.

3. **Separate interfaces, no shared root** — `AgentProvider` and
   `ShellProvider` as unrelated interfaces sharing only `InvokeResult`.
   - *Tradeoffs:* No Liskov issues. But loses the ability to express
     "thing that does work in a container" as a shared concept. No
     common type for container-level concerns like `onLine`.
   - *Verdict:* Rejected — there IS a meaningful shared concept
     (container execution) that deserves a common root.

4. **Three-level hierarchy with ContainerProvider root** —
   `ContainerProvider<TContext>` is the generic root. `ShellProvider` and
   `AgentProvider` are siblings beneath it, each with their own context
   type. `AgentProvider` narrows the generic to `LlmAgentContext`.
   `ClaudeCodeAgentProvider` implements `AgentProvider`.
   - *Tradeoffs:* Clean separation. Each tier carries only relevant
     fields. Type system enforces which runner can use which provider.
     Shell sits alongside agents, not under them.
   - *Verdict:* Chosen — maps the conceptual hierarchy to the type
     hierarchy without Liskov violations or dead fields.

## Decision

Introduce a `ContainerProvider<TContext extends ContainerContext>` root
interface with `ShellProvider` and `AgentProvider` as sibling branches,
each owning their own context type and runner.

The naming reflects the conceptual model: `ContainerProvider` is "thing
that does work in a container," `AgentProvider` is "thing that acts as an
autonomous LLM agent," and `ShellProvider` is "thing that runs a command."
This preserves `AgentProvider` as the established term for LLM agents
(from ADR 001 and the codebase) while giving the broader concept a name
that matches its scope.

This also supersedes the `UtilityContainer` concept from PRD 011 — shell
jobs are just the engine with different wiring, not a separate
abstraction.

## Type Hierarchy

```typescript
// Contexts — what each provider receives
ContainerContext                     // container: ContainerHandle, onLine?
  ├─ ShellContext                    // command: string
  └─ LlmAgentContext                // task, loopNumber, maxLoops, checkFailure?, customPrompt?

// Providers — what does work in a container
ContainerProvider<TContext extends ContainerContext>
  invoke(ctx: TContext): Promise<InvokeResult>

ShellProvider             implements ContainerProvider<ShellContext>
AgentProvider<T extends LlmAgentContext> extends ContainerProvider<T>
  └─ ClaudeCodeAgentProvider implements AgentProvider<LlmAgentContext>

// Runners — orchestration strategies
AgentRunner               // LLM loop: invoke → check → re-invoke. Requires AgentProvider.
ShellExecutor             // Single invoke, return. Requires ContainerProvider<ShellContext>.
```

## Key Design Decisions

| # | Decision | Resolution |
|---|----------|------------|
| 1 | What to build next after ADR 001 | Second provider (ShellProvider) — validates abstraction AND provides utility containers |
| 2 | `task` field reuse for shell commands | No — shell gets `command` on `ShellContext`, LLM keeps `task` on `LlmAgentContext` |
| 3 | Base context name | `ContainerContext` — describes what it is (container-level concerns) |
| 4 | `onLine` callback placement | On `ContainerContext` (base) — both shell and LLM produce streamable output |
| 5 | `AgentProvider` as marker interface | Yes — narrows the generic bound, no new methods. Evolve if needed. |
| 6 | One runner or two | Two — `AgentRunner` (LLM loop) and `ShellExecutor` (single invoke). Different orchestration, different runners. |
| 7 | Runner naming | Keep `AgentRunner` (entrenched), add `ShellExecutor` |
| 8 | `InvokeResult` shape | `{ completed: boolean }` for both tiers. Evolve to discriminated union when a consumer needs richer data. |
| 9 | Provider wiring | Direct construction — orchestrator knows which code path it's on. Factory deferred until multiple LLM providers exist. |
| 10 | UtilityContainer (PRD 011) | Superseded — shell jobs are just the engine with `ShellProvider` wiring, not a separate abstraction |
| 11 | One-shot LLM calls (e.g., PR summaries) | Shell tier — invoking a model binary with a prompt is a shell command, not an agent loop |

## Implementation Sequence

1. **Refactor types** — Split `AgentContext` into `ContainerContext`,
   `ShellContext`, `LlmAgentContext`. Rename current `AgentProvider` to
   `ContainerProvider` (base) + `AgentProvider` (LLM tier). Update
   `ClaudeCodeAgentProvider`.

2. **Build ShellProvider + ShellExecutor** — New files, minimal code.
   Unit tests with mock `ContainerHandle`.

3. **Integration smoke test** — `ShellExecutor` + `ShellProvider`
   running `echo hello` in a real container. Validates wiring end-to-end.

4. **PR summary generation** — First real consumer. `ShellProvider` runs
   one-shot Claude CLI call, captures output for PR title/body.

5. **Difficulty-based model selection** (issue #8) — Layer on top once
   provider hierarchy is stable.

## Consequences

- **Positive:** Validates the provider abstraction with a concrete second
  implementation. Eliminates the need for a separate UtilityContainer
  abstraction. Type system enforces which runner can use which provider.
  Shell jobs reuse the full container lifecycle (creation, network
  restriction, cleanup) without duplication. Future providers (Codex,
  Aider) slot cleanly into the `AgentProvider` branch.
- **Negative:** Renames `AgentProvider` (the current interface extracted
  yesterday) to `ContainerProvider`, adding churn one commit after
  extraction. The three-level hierarchy is more complex than the original
  flat interface — justified only if the shell tier gets real consumers.
- **Neutral:** `AgentRunner` name is preserved despite the rename of the
  interface it consumes. PRD 011's UtilityContainer design is dead — PR
  summary generation will be re-scoped against the shell tier.

## Open Questions

- **Discriminated union return type** — deferred until a consumer needs
  richer data than `{ completed: boolean }` (e.g., stdout capture, exit
  code). The shell executor's caller can use `onLine` or read container
  files in the interim.
- **Provider factory/registry** — deferred until multiple LLM providers
  exist and the orchestrator needs config-driven provider selection.
- **Difficulty-based model selection** — orthogonal to this hierarchy,
  sequenced as step 5 after the shell tier is validated.
