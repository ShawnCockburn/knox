# Evolve Knox toward platform agnosticism instead of rewriting

## Status

**Accepted**

## Context

Knox had accumulated bugs (sentinel completion broken for queues, general queue
flakiness) and felt too tightly coupled to Claude Code as the sole agent
provider. The question was whether to rebuild from scratch with a more generic,
pipeline-oriented architecture — or to fix what's broken and evolve the existing
modular design.

A similar project (Sandcastle by Matt Pocock) had launched with a different
scope — lower-level container/worktree orchestration without task management —
which prompted reflection on Knox's positioning.

Key constraints: Knox already has well-factored abstractions (SourceProvider,
ResultSink, ContainerRuntime, QueueSource) that are task-agnostic. The
"code-specific" parts are implementations, not interfaces. The desire for a
rewrite was partly driven by accumulated mess and partly by the dopamine of a
fresh start.

## Decision Tree

1. **Full rewrite** — start from scratch with a generic agentic orchestrator
   - _Tradeoffs:_ clean slate and chance to rethink everything, but loses all
     edge-case handling, bug fixes, and hard-won design decisions (network
     isolation, git bundle extraction, dependency resolution, resume support).
     Rewrites don't fix category-2 problems — they reset the clock until new
     mess accumulates.
   - _Verdict:_ Rejected — the architecture is sound; the problems are on top of
     good bones, not in the foundations.

2. **Provider-specific model strings** — tasks specify
   `provider: claude, model: opus` directly
   - _Tradeoffs:_ simple pass-through, no mapping layer needed. But leaks
     implementation details into task config — swapping providers requires
     touching every task.
   - _Verdict:_ Rejected — fails the portability constraint of swapping
     providers with zero task config changes.

3. **Auto-difficulty classification** — a preprocessing LLM call determines task
   difficulty automatically
   - _Tradeoffs:_ removes human judgment from the loop, scales automatically.
     But adds latency and cost to every task, and the baseline (human writes
     `difficulty: complex` in two seconds) is right 90% of the time.
   - _Verdict:_ Deferred — future optimization, not a v1 design concern.

4. **Evolve in place with AgentProvider interface and difficulty-based model
   selection** — fix bugs, extract an AgentProvider abstraction, use
   `difficulty` field for portable model selection
   - _Tradeoffs:_ preserves all existing work and edge-case handling. Requires
     disciplined refactoring rather than a clean-room rewrite. The abstraction
     must be validated by building a second provider.
   - _Verdict:_ Chosen — the architecture already supports this evolution; the
     bugs are fixable, not structural.

## Decision

Evolve Knox in place toward platform agnosticism by introducing an
`AgentProvider` interface and difficulty-based model selection, rather than
rewriting.

The sentinel/completion bug was a one-line fix (orchestrator checked
`outcome.ok` instead of `outcome.result.completed`), which demonstrated that the
problems are surface-level, not architectural. The existing source/agent/sink
pipeline already supports utility containers (non-code tasks) with new sink
implementations — no new architecture needed.

## Consequences

- **Positive:** Preserves months of edge-case handling and design work. Enables
  provider swapping (Claude, Codex, future providers) with a single config
  change. Utility containers (stdout capture, file generation) fit the existing
  pipeline. Sentinel bug is fixed immediately.
- **Negative:** Requires discipline to avoid re-coupling to Claude-specific
  details during incremental refactoring. The `AgentProvider` abstraction is
  unvalidated until a second provider is built.
- **Neutral:** Task configs gain an optional `difficulty` field
  (`complex | balanced | easy`, defaults to `balanced`). Provider config maps
  difficulty to concrete model names. The mapping is user-owned, not a framework
  abstraction Knox maintains.

## Open Questions

- Auto-difficulty classification via preprocessing LLM — deferred, revisit once
  manual labeling proves insufficient at scale.
- Long-running process with task/queue pushing (daemon mode) — discussed
  briefly, architecturally compatible with current design but not yet designed
  in detail.
