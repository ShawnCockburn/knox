# Plan: Difficulty-Based Model Selection

> Source PRD: `prd/014-difficulty-based-model-selection.md`

## Architectural decisions

Durable decisions that apply across all phases:

- **Public configuration language**: Knox users specify `difficulty`
  (`complex`, `balanced`, `easy`) instead of raw `model` strings on every
  public task-configuration surface.
- **Resolution boundary**: Difficulty resolves to a concrete model string before
  the engine is invoked. The engine and agent-provider layer continue to operate
  on `model: string` and remain unaware of Difficulty.
- **Core abstraction**: The queue orchestrator and single-run CLI depend on an
  injected **Resolve Difficulty** function, not on provider-specific maps.
- **Provider mapping model**: Each provider supplies its own complete
  **Difficulty Map**. Claude Code ships the initial default map:
  `complex → opus`, `balanced → sonnet`, `easy → haiku`.
- **Defaults and overrides**: `balanced` is the global default. Queue defaults
  provide a queue-wide baseline, and individual queue items may override it.
- **Validation ownership**: Queue sources stay as dumb parsers. Validation owns
  enum checking, migration errors for legacy `model`, and acceptance of valid
  difficulty values across YAML, Markdown, and GitHub issue inputs.
- **Result visibility**: User-facing results and summaries show both the
  requested Difficulty and the resolved concrete model so intent and execution
  are both visible.
- **Migration policy**: The old `model` field and `--model` flag are removed
  rather than supported as aliases; migration feedback must be explicit and
  actionable.

---

## Phase 1: Difficulty Core + Single-Run CLI

**User stories**: 2, 5, 6, 8, 9, 10, 12

### What to build

Introduce the Difficulty abstraction as a dedicated core module with the enum,
map contract, and pure resolution behavior. Wire the single-run CLI to accept
`--difficulty`, default it to `balanced`, resolve it through the injected
provider mapping, and pass the resolved model into the engine unchanged.

Extend single-run results and summary formatting so the run output shows both
the resolved model and the requested difficulty.

### Acceptance criteria

- [ ] A dedicated Difficulty abstraction exists with the portable enum values
      `complex`, `balanced`, and `easy`
- [ ] Provider maps are compile-time complete for all three difficulty levels
- [ ] Single-run CLI accepts `--difficulty` and defaults to `balanced`
- [ ] Single-run CLI no longer exposes `--model`
- [ ] Single-run execution resolves difficulty before invoking the engine
- [ ] Engine inputs remain concrete model strings only
- [ ] Run results include both `difficulty` and resolved `model`
- [ ] Summary output shows `Model: <resolved-model> (<difficulty>)`
- [ ] Tests cover resolver behavior for all three difficulty levels
- [ ] Tests cover single-run CLI defaulting and explicit difficulty selection

---

## Phase 2: Local Queue End-to-End

**User stories**: 1, 2, 3, 4, 7, 11

### What to build

Replace `model` with `difficulty` across local queue manifests and
directory-based Markdown task queues. Keep source parsing thin, then validate
Difficulty centrally and resolve it in the orchestrator after defaults and
per-item overrides are merged.

This slice should produce a complete local-queue path: queue defaults can set a
queue-wide difficulty baseline, items can override it, the orchestrator invokes
the engine with the resolved model, and migration errors guide users away from
legacy `model`.

### Acceptance criteria

- [ ] Queue manifests accept `difficulty` on both queue defaults and queue items
- [ ] Directory-based Markdown tasks accept `difficulty` in frontmatter
- [ ] Queue default layering uses `balanced` when neither defaults nor item
      specify difficulty
- [ ] Item-level difficulty overrides queue defaults
- [ ] Legacy `model` in queue YAML is rejected with a migration error that
      tells the user to use `difficulty`
- [ ] Legacy `model` in Markdown frontmatter is rejected with the same clear
      migration guidance
- [ ] Invalid difficulty values are rejected in the validation layer
- [ ] Orchestrator depends on injected Resolve Difficulty behavior rather than a
      concrete provider map
- [ ] Orchestrator resolves difficulty for each item before invoking the engine
- [ ] Queue run outcomes preserve both requested difficulty and resolved model
- [ ] Tests cover validation, defaulting, overrides, and orchestrator
      resolution for local queues

---

## Phase 3: GitHub Queue Parity

**User stories**: 1, 2, 3, 4, 7, 11

### What to build

Apply the same Difficulty contract to GitHub Issue ingestion so GitHub-backed
queues behave the same way as local queues. GitHub issue frontmatter, GitHub
queue defaults, validation, and orchestration should all use Difficulty with
the same defaulting, override, and migration rules.

This phase is complete when a GitHub issue can declare difficulty, inherit a
GitHub queue default, override that default per issue, and run through the
existing queue pipeline with a resolved model.

### Acceptance criteria

- [ ] GitHub issue frontmatter accepts `difficulty`
- [ ] GitHub queue defaults accept `difficulty`
- [ ] GitHub-ingested items inherit `balanced` when no difficulty is specified
- [ ] Per-issue difficulty overrides GitHub queue defaults
- [ ] Legacy `model` in GitHub issue frontmatter is rejected with the same
      migration error used by other queue sources
- [ ] Invalid difficulty values from GitHub issues are rejected by the
      validation layer
- [ ] GitHub queue execution resolves difficulty before engine invocation
- [ ] Tests cover GitHub issue parsing, defaults, overrides, and migration
      errors

---

## Phase 4: Documentation + Migration Surface

**User stories**: 1, 5, 7, 8

### What to build

Update the product surface so all user-facing guidance reflects Difficulty as
the portable model-selection language. This includes CLI help text, README
examples, queue examples, and any migration-oriented messaging shown when users
attempt to use the removed `model` surface.

This phase ensures the feature is discoverable and the migration path is clear
without requiring users to read the PRD.

### Acceptance criteria

- [ ] CLI help text documents `--difficulty` and no longer documents `--model`
- [ ] README single-run examples use `--difficulty`
- [ ] README queue examples and defaults use `difficulty`
- [ ] User-facing examples show the three supported difficulty values
- [ ] Migration guidance consistently explains that `model` has been replaced by
      `difficulty`
- [ ] Output examples show the combined `Model: <resolved-model> (<difficulty>)`
      format
