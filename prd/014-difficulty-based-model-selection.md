# PRD 014: Difficulty-Based Model Selection

## Problem Statement

Knox queue items and CLI tasks currently specify a concrete `model` string
(e.g., `sonnet`, `opus`) directly in task configuration. This couples task
definitions to a specific provider's model naming — swapping from Claude
Code to a different agent provider would require updating every task config.
The `model` field is a provider-specific implementation detail leaking into
a layer that should be provider-agnostic.

## Solution

Replace the `model` field with a portable `difficulty` enum (`complex`,
`balanced`, `easy`) across all task configuration surfaces. A higher-level
resolution layer maps difficulty to a concrete model string before the
engine is invoked. The engine and providers continue to operate on concrete
model strings — they are unaware of the difficulty concept.

The mapping is provider-specific (Claude Code ships its own default map),
but the resolution is injected into the orchestrator and CLI as a pure
function, keeping them decoupled from any specific provider's mapping
structure.

## User Stories

1. As a Knox user, I want to specify task difficulty instead of a model name, so that my queue configs are portable across agent providers.
2. As a Knox user, I want a `balanced` default when I omit difficulty, so that I don't have to annotate every task.
3. As a Knox user, I want to set a queue-wide default difficulty, so that I can control cost/capability for an entire queue in one place.
4. As a Knox user, I want to override difficulty on individual items, so that I can allocate a stronger model to harder tasks within the same queue.
5. As a Knox user, I want to specify `--difficulty` on the CLI for single tasks, so that I can control the model tier without editing config files.
6. As a Knox user, I want `KnoxResult` to show both the difficulty and the resolved model, so that I can understand what ran and why.
7. As a Knox user, I want a clear error if I use the old `model` field, so that I know to migrate to `difficulty`.
8. As a Knox user, I want the display output to show `Model: sonnet (balanced)`, so that I see both the intent and the concrete model at a glance.
9. As a Knox contributor, I want adding a new provider's difficulty mapping to be as simple as adding a new file, so that the system follows the Open/Closed Principle.
10. As a Knox contributor, I want the `DifficultyMap` type to enforce all three difficulty levels at compile time, so that incomplete maps are caught before runtime.
11. As a Knox contributor, I want the orchestrator to depend on a `ResolveDifficulty` function type rather than a concrete map, so that the resolution strategy is opaque and swappable.
12. As a Knox contributor, I want the engine to remain unaware of difficulty, so that it stays focused on executing tasks with a resolved model string.

## Implementation Decisions

### Difficulty module (`difficulty/`)

- New self-contained module with: `Difficulty` enum (string enum with values `complex`, `balanced`, `easy`), `DifficultyMap` type (mapped type requiring all enum keys, enforced at the type level), `ResolveDifficulty` function type (`(difficulty: Difficulty) => string`), a concrete `resolveDifficulty(difficulty, map)` function, and per-provider map constants.
- The `Difficulty` enum lives in this module, not in the shared `types.ts` file — the module is the authoritative home for the concept.
- Per-provider maps are separate files (e.g., `claude_code_map.ts`). Adding a new provider's map requires only adding a new file — Open/Closed Principle.
- Claude Code's default map: `{ complex: "opus", balanced: "sonnet", easy: "haiku" }`.

### Orchestrator injection

- `OrchestratorOptions` gains a required `resolveDifficulty: ResolveDifficulty` field.
- The orchestrator calls this function to resolve each item's difficulty to a concrete model string before passing it to `Knox.run()`.
- The orchestrator does not know about maps, providers, or mapping structure — the function signature is the contract.
- The caller (CLI) wires it via partial application: `(d) => resolveDifficulty(d, CLAUDE_CODE_MAP)`.

### Queue item config

- `model` field removed from `QueueItem` and `QueueDefaults`.
- `difficulty` field added to both (optional, defaults to `balanced`).
- Standard config layering applies: queue defaults set baseline, per-item overrides.

### Engine internals

- `Knox.run()` continues to accept a `model: string` — resolved concrete model, unchanged.
- `KnoxResult` gains a `difficulty: Difficulty` field alongside the existing `model: string`.
- No changes to `AgentProvider`, `ContainerProvider`, `LlmAgentContext`, `AgentRunner`, or `ContainerSession`.

### CLI

- `--model` flag replaced with `--difficulty` flag (defaults to `balanced`).
- CLI resolves difficulty to model string using the same partial-applied function.
- Display output format: `Model: sonnet (balanced)`.

### Queue sources

- All three sources (`FileQueueSource`, `DirectoryQueueSource`, `GitHubIssueQueueSource`) parse `difficulty` instead of `model`.
- Sources are dumb parsers — they pass the raw value through.

### Validation

- Reject invalid `difficulty` values (not in the enum).
- Reject any `model` field with a clear migration error: `"model" is no longer supported, use "difficulty" instead (complex | balanced | easy)`.
- Validation remains in the existing validation layer, not in sources.

### Provider selection

- Hardcoded to Claude Code for now — only one provider exists.
- A separate issue (GitHub issue #9) tracks adding `.knox/config.yml` for provider selection when a second provider arrives.

### `DifficultyMap` completeness

- All three difficulty levels are required in every map — enforced by a mapped type at compile time.
- The resolver function can never fail at runtime because the type system guarantees the key exists.

## Testing Decisions

Good tests verify external behavior through the public interface, not implementation details. Tests should be resilient to refactoring — if the implementation changes but the behavior is the same, tests should still pass.

### Modules to test

- **Difficulty module** — unit tests for the resolver function (each difficulty level maps correctly), type-level completeness of maps (compile-time, not runtime). Prior art: simple pure-function tests similar to existing feature registry tests.
- **Validation** — test rejection of `model` field with migration error message, test rejection of invalid difficulty values, test acceptance of valid difficulty values. Prior art: existing `test/queue/validation_test.ts`.
- **Orchestrator** — test that injected `ResolveDifficulty` is called for each item and the resolved model string reaches the engine. Prior art: existing `test/queue/orchestrator_test.ts` uses mock providers.
- **Queue sources** — test parsing `difficulty` from YAML frontmatter, Markdown frontmatter, and GitHub issue body. Prior art: existing source test files (`file_queue_source_test.ts`, `directory_queue_source_test.ts`, `github_issue_queue_source_test.ts`).

## Out of Scope

- Auto-difficulty classification (inferring difficulty from task content) — deferred per ADR 001.
- Provider selection config (`.knox/config.yml`) — tracked in GitHub issue #9.
- Raw `model` string escape hatch — intentionally excluded to enforce provider portability. May be revisited in the future.
- Difficulty-to-cost estimation or billing awareness.

## Further Notes

- This feature is referenced in ADR 001 (`adr/001-evolve-knox-toward-platform-agnosticism.md`) as a key step toward platform agnosticism.
- The `ResolveDifficulty` function type is the central abstraction. It decouples the orchestrator from mapping structure and resolution strategy, making future changes (config-driven maps, per-item overrides, dynamic resolution) additive rather than breaking.
