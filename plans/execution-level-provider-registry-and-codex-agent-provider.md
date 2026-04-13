# Plan: Execution-Level Provider Registry and Codex Agent Provider

> Source PRD: `prd/016-execution-level-provider-registry-and-codex-agent-provider.md`

## Architectural decisions

Durable decisions that apply across all phases:

- **Execution policy**: `provider` is an execution-level choice, not task
  metadata. It is supplied by CLI flags or top-level Knox project config, and
  there is no runtime default provider.
- **Provider set**: the built-in provider set is closed for now. Supported
  provider ids are internal built-ins such as `claude` and `codex`, not
  plugin-defined extensions.
- **Resolution boundary**: provider choice resolves once at the CLI/config
  boundary into a **Resolved Execution Context** that is reused across
  preflight, image/runtime validation, engine execution, and reporting.
- **Core abstraction**: a deep **Provider Registry** maps the selected provider
  id to a **Provider Spec** that owns provider-specific behavior while the Knox
  core keeps container lifecycle, queue scheduling, result handling, and outer
  loop orchestration provider-agnostic.
- **Provider responsibilities**: each **Provider Spec** owns auth discovery,
  required network hosts, one-time container preparation, prompt construction,
  agent-provider construction, and provider-specific difficulty-to-model
  resolution.
- **Task portability**: queue items remain provider-agnostic after the
  difficulty migration. Task-level `provider` fields are ignored with a warning
  rather than affecting execution policy.
- **Authentication policy**: provider-owned auth discovery is read-only.
  Interactive login remains outside Knox. For Codex, Knox reuses host-side
  cached login state, copies only the auth material needed into the container,
  and does not inherit host config, profiles, or session preferences.
- **Container preparation**: provider-specific runtime setup happens once per
  invocation through a `prepareContainer` hook that produces explicit provider
  runtime state and performs a lightweight self-check before loop 1.
- **Network policy**: providers declare required hostnames, and Knox owns the
  shared DNS/IP resolution and container egress enforcement.
- **Runtime packaging**: the Knox base image ships both provider CLIs at stable
  internal locations outside the normal tool PATH. Custom images remain
  user-owned and must already contain the selected provider runtime.
- **Queue/reporting policy**: one invocation uses one provider. Resumed queues
  may switch providers, but Knox records provider provenance per item and warns
  when queue history mixes providers.

---

## Phase 1: Explicit Provider Resolution for Single Runs

**User stories**: 1, 2, 3, 4, 35, 36, 38, 39, 40, 41, 42, 43

### What to build

Introduce execution-level provider resolution for `knox run`. A single-run
invocation should resolve provider choice from CLI flags and project config,
fail clearly when no provider is configured, and pass a resolved provider
context into preflight and engine execution rather than relying on Claude-only
helpers.

Claude must migrate onto the same provider-spec path in this slice so the new
architecture is validated by a real working provider instead of adding a
parallel Codex-only branch.

### Acceptance criteria

- [ ] `knox run` accepts an explicit execution-level provider choice
- [ ] Top-level project config can declare a preferred provider for single runs
- [ ] CLI provider flags override project config
- [ ] Knox fails clearly when no provider is configured
- [ ] Provider resolution happens once before the engine starts
- [ ] The engine consumes resolved execution capabilities rather than raw
      provider strings
- [ ] Claude runs successfully through the provider-spec path
- [ ] Difficulty remains task-level while provider remains execution-level
- [ ] Tests cover config precedence, explicit-provider requirements, and
      closed-set provider validation

---

## Phase 2: Queue and Init Provider Policy

**User stories**: 5, 6, 7, 8, 9, 10, 11, 37

### What to build

Extend the same execution-level provider policy to `knox queue`, queue
discovery, GitHub-backed queues, and `knox init`. A queue invocation should
resolve one provider for the full command, ignore any task-level provider
fields with a warning, and preserve provider-agnostic queue item behavior.

This slice is complete when `knox run`, `knox queue`, and `knox init` all
share one provider-resolution mental model.

### Acceptance criteria

- [ ] `knox queue` uses the same provider resolution rules as `knox run`
- [ ] Queue discovery mode resolves one provider for the entire invocation
- [ ] Queue manifests, Markdown task frontmatter, and GitHub task defaults
      ignore task-level provider fields with a warning
- [ ] Queue items continue to control only difficulty, not provider
- [ ] `knox init` captures an explicit preferred provider during setup
- [ ] `knox init --provider ...` skips prompting and writes the selected
      provider directly
- [ ] Provider-owned auth discovery remains outside queue item schemas
- [ ] Tests cover ignored task-level provider warnings and init-time provider
      capture behavior

---

## Phase 3: Codex Base-Image Single-Run Happy Path

**User stories**: 12, 13, 14, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 31

### What to build

Add Codex as a first-class provider for single-run execution using the Knox
base image. A user who is already logged into Codex on the host should be able
to run `knox run` with provider `codex`, have Knox prepare a clean
container-local runtime state, execute Codex non-interactively inside the
existing Knox container loop, and rely on the same completion contract and
custom-prompt control surface used by Claude.

This phase focuses on the end-to-end happy path using the Knox-managed base
image, not on every auth-storage or custom-image edge case.

### Acceptance criteria

- [ ] The Knox base image contains both Claude and Codex runtimes
- [ ] Codex can be selected as the provider for a single run
- [ ] Codex uses the same Knox outer loop behavior as Claude
- [ ] Codex runs non-interactively inside the Knox container
- [ ] Codex reuses existing host-side login state when available
- [ ] Knox treats host-side Codex auth as read-only
- [ ] Knox copies only the auth material needed for Codex into the container
- [ ] Knox ignores host Codex config, profiles, and session preferences
- [ ] Codex uses the existing `KNOX_COMPLETE` completion contract
- [ ] Custom prompts continue to work when provider `codex` is selected
- [ ] Provider runtimes remain internal implementation details rather than
      normal PATH tools
- [ ] Container preparation performs a lightweight provider self-check before
      the first loop
- [ ] Tests cover Codex prompt construction, command invocation shape,
      completion detection, and single-run happy-path container prep

---

## Phase 4: Codex Cross-Platform Auth Discovery

**User stories**: 15, 20, 44

### What to build

Expand Codex auth discovery beyond the initial happy path so Knox supports the
expected cached-login storage modes across host platforms. Codex provider
resolution should discover file-backed and keyring-backed auth stores through
provider-owned storage adapters, fail clearly when multiple sources disagree,
and keep host-side auth handling read-only and deterministic.

This phase is complete when Codex auth discovery is a reliable provider-owned
module rather than a platform-specific special case.

### Acceptance criteria

- [ ] Codex auth discovery supports both file-backed and keyring-backed host
      storage modes
- [ ] Cross-platform Codex auth expectations align with Knox's current Claude
      support standards
- [ ] Knox discovers Codex auth directly from host storage without invoking a
      host Codex binary at runtime
- [ ] When multiple Codex auth sources are present and disagree, Knox fails
      with a clear ambiguity error
- [ ] Codex auth discovery remains provider-owned rather than forced into a
      fake shared credential abstraction
- [ ] Tests cover file-backed discovery, keyring-backed discovery,
      cross-platform selection behavior, and ambiguity failures

---

## Phase 5: Provider Runtime and Network Enforcement

**User stories**: 27, 28, 29, 30

### What to build

Enforce provider runtime and network requirements consistently across base-image
and custom-image executions. The selected provider should declare required
hosts, Knox should resolve and apply the resulting network policy, and custom
images should fail clearly if they do not contain the selected provider runtime
at the expected canonical location.

This slice turns provider intent into enforceable runtime policy without
leaking provider-specific infrastructure logic into the rest of Knox.

### Acceptance criteria

- [ ] Providers declare hostname-level network requirements
- [ ] Knox resolves provider-declared hosts and applies the egress filter
      automatically
- [ ] Codex allows the union of required OpenAI hosts for the supported
      cached-auth modes
- [ ] Selecting a provider with a custom image validates that the image
      contains the corresponding provider runtime
- [ ] Custom-image failures are clear when the selected provider runtime is
      absent
- [ ] The same provider runtime validation and network policy work for both
      single-run and queue execution
- [ ] Tests cover provider-declared hosts, resolved network policy, and
      custom-image runtime validation failures

---

## Phase 6: Provider-Aware Results and Queue Reports

**User stories**: 32

### What to build

Surface provider choice as a first-class execution fact in run summaries, queue
reports, and output formatting. Users should be able to see which provider
actually ran without inspecting config or reconstructing execution context from
logs.

This slice is narrowly about honest reporting of execution policy.

### Acceptance criteria

- [ ] Single-run summaries show the selected provider alongside existing model
      and difficulty information
- [ ] Queue reports and queue output surfaces record the selected provider
- [ ] Provider is included in user-visible run/report data structures rather
      than inferred indirectly
- [ ] Tests cover provider formatting in summaries and queue outcomes

---

## Phase 7: Resume-Time Provider Switching and Provenance

**User stories**: 33, 34, 45

### What to build

Finish the queue story for mixed-provider history. A resumed queue invocation
should be allowed to use a different provider than the original run, Knox
should warn when a queue history now spans multiple providers, and each item's
recorded outcome should preserve the provider that actually executed it.

This phase is complete when resumed queues can change providers without hiding
what happened.

### Acceptance criteria

- [ ] Resumed queues may switch providers between invocations
- [ ] Knox warns when a resumed queue mixes providers across item history
- [ ] Provider provenance is recorded per item outcome
- [ ] Queue history remains reviewable even when different items were executed
      by different providers
- [ ] Tests cover resume-time provider switching, mixed-provider warnings, and
      per-item provenance recording
