# PRD 016: Execution-Level Provider Registry and Codex Agent Provider

## Problem Statement

Knox currently runs a single hardcoded LLM agent provider. The codebase has an
`AgentProvider` abstraction, but the real execution flow is still Claude-first:
provider selection is not a first-class user choice, provider-specific
authentication and network policy live outside a unified abstraction, and the
engine still assumes Claude-centric wiring.

This creates three user-facing problems.

First, Knox cannot add Codex as a real peer to Claude without spreading more
provider-specific conditionals through the CLI, preflight, auth, network, and
engine layers.

Second, execution policy is not modeled clearly. Provider choice should be an
execution-level decision made by the user for a run or project, not task-level
metadata embedded inside queue items.

Third, the current Claude implementation cannot validate whether Knox's provider
abstractions are actually sufficient for multiple agent runtimes. Until a
second real agent provider exists, the architecture remains only partially
proven.

The user wants Knox to add a first-class Codex provider while preserving the
existing container-based execution model, keeping provider choice explicit,
keeping task configuration provider-agnostic after the prerequisite difficulty
migration, and reusing existing host-side Codex login state in a way similar to
the current Claude experience.

## Solution

Introduce an execution-level provider registry built around an internal
`ProviderSpec` abstraction. A user chooses the provider explicitly through CLI
flags or project configuration, and Knox resolves that choice into provider
behavior at the boundary before the engine runs.

The selected provider owns its own authentication discovery, network host
policy, one-time container preparation, agent-provider construction, prompt
builder, and later difficulty-to-model mapping. Knox core owns only the generic
orchestration: config loading, container lifecycle, loop orchestration, queue
scheduling, and result reporting.

Claude is migrated onto the same provider-spec path so Knox has one consistent
multi-provider execution architecture rather than a legacy Claude path plus a
new Codex path.

Codex is integrated by wrapping the official Codex CLI inside the Knox
container, following the same high-level pattern Knox uses for Claude: the
container remains the only sandbox boundary, Knox performs the outer loop and
verification cycle, and the provider uses the existing Knox completion contract
with progress-file context and `KNOX_COMPLETE`.

Host-side provider selection is explicit and required. Queue tasks do not choose
providers. After the prerequisite difficulty migration lands, tasks choose only
difficulty, while provider-specific model resolution happens through the
selected provider.

## User Stories

1. As a Knox user, I want to choose an agent provider explicitly for a run, so
   that Knox never silently assumes the wrong provider.
2. As a Knox user, I want project configuration to declare a preferred provider,
   so that I do not need to repeat the same provider flag on every command.
3. As a Knox user, I want CLI flags to override project configuration, so that I
   can temporarily use a different provider for a particular invocation.
4. As a Knox user, I want Knox to fail clearly when no provider is configured,
   so that missing execution policy is obvious instead of implicit.
5. As a Knox user, I want provider choice to live at the execution level, so
   that queue items remain portable and provider-agnostic.
6. As a Knox user, I want queue items to control only difficulty after the
   prerequisite migration, so that I can vary capability per task without
   varying providers per task.
7. As a Knox user, I want queue manifests and task frontmatter to ignore
   provider fields with a warning, so that accidental task-level provider
   configuration does not silently change execution behavior.
8. As a Knox user, I want `knox run` and `knox queue` to use the same provider
   resolution rules, so that there is one mental model for execution.
9. As a Knox user, I want queue discovery mode to use one provider for the
   entire invocation, so that a single command has one execution policy.
10. As a Knox user, I want `knox init` to ask for my preferred provider, so that
    a new project starts with explicit provider configuration.
11. As a Knox user, I want `knox init --provider ...` to skip prompting, so that
    automation and repeatable setup remain possible.
12. As a Knox user, I want Knox to support Codex as a first-class provider, so
    that I can run Knox with either Claude or Codex using the same orchestration
    model.
13. As a Knox user, I want Claude and Codex to share the same outer Knox loop
    behavior, so that retries, checks, nudges, and result handling remain
    consistent across providers.
14. As a Knox user, I want Codex to reuse my existing host login when possible,
    so that I do not need to hand Knox a new secret for normal local use.
15. As a Knox user, I want Knox to discover Codex auth from either file-backed
    or keyring-backed host storage, so that my local Codex setup works without
    special reconfiguration.
16. As a Knox user, I want Knox to require that I log into Codex before running
    Knox with Codex, so that Knox does not need to own interactive login flows.
17. As a Knox user, I want Knox to treat host-side Codex auth as read-only, so
    that Knox does not become the source of truth for my local credentials.
18. As a Knox user, I want Knox to copy only the auth needed for Codex into the
    container, so that runs start from a clean provider runtime state.
19. As a Knox user, I want Knox to ignore my host Codex config and session
    preferences, so that container runs remain deterministic across machines.
20. As a Knox user, I want Knox to detect ambiguous Codex auth sources and fail
    clearly, so that it never guesses which credentials I intended it to use.
21. As a Knox user, I want the Knox container to remain the only sandbox
    boundary, so that provider internals do not add a second, competing approval
    model.
22. As a Knox user, I want Codex to run non-interactively inside the container,
    so that unattended Knox runs behave predictably.
23. As a Knox user, I want Codex to keep the same `KNOX_COMPLETE` contract as
    Claude, so that task completion remains understandable and provider-neutral.
24. As a Knox user, I want custom prompts to keep working across providers, so
    that provider selection does not disable an existing control surface.
25. As a Knox user, I want the base Knox image to contain both agent CLIs, so
    that provider selection does not require a separate base-image architecture.
26. As a Knox user, I want provider runtimes isolated from the normal tool PATH,
    so that agent CLIs stay internal implementation details rather than general
    project dependencies.
27. As a Knox user, I want custom images to declare the selected provider CLI
    themselves, so that `image:` continues to mean I own that environment.
28. As a Knox user, I want provider-specific network policy to be applied
    automatically, so that each run keeps least-privilege egress without manual
    setup.
29. As a Knox user, I want Knox to resolve provider network hosts for me, so
    that provider modules express intent while Knox owns the infrastructure
    details.
30. As a Knox user, I want Codex runs to allow the required OpenAI endpoints for
    either supported cached-auth mode, so that local auth choice does not become
    a network-policy footgun.
31. As a Knox user, I want Knox to perform a lightweight provider self-check in
    the container before loop 1, so that missing binaries or unreadable auth
    fail fast.
32. As a Knox user, I want provider choice surfaced in run summaries and queue
    reports, so that I can see what actually executed.
33. As a Knox user, I want resumed queues to be allowed to switch providers, so
    that I can continue work with a different agent when needed.
34. As a Knox user, I want provider provenance recorded per item when resumes mix
    providers, so that queue history remains honest and reviewable.
35. As a Knox maintainer, I want Claude migrated onto the same provider-spec path
    as Codex, so that Knox has one coherent execution architecture.
36. As a Knox maintainer, I want provider-specific logic encapsulated behind a
    deep module, so that adding another built-in provider does not require
    touching unrelated orchestration code.
37. As a Knox maintainer, I want provider auth discovery to remain provider-owned,
    so that Knox does not force incompatible credential shapes into a fake
    shared abstraction.
38. As a Knox maintainer, I want provider-specific prompt builders, so that each
    agent can have default instructions suited to its runtime while still using
    shared Knox context.
39. As a Knox maintainer, I want provider resolution to happen before the engine
    starts, so that core orchestration depends on capabilities rather than raw
    config strings.
40. As a Knox maintainer, I want execution-level provider context resolved once
    per invocation, so that host auth and network discovery are consistent
    across preflight and execution.
41. As a Knox maintainer, I want per-task model resolution to remain separate
    from execution-level provider selection, so that queues can vary difficulty
    while keeping one provider policy.
42. As a Knox maintainer, I want provider types to stay internal for now, so
    that Knox can stabilize the architecture before exposing it as an extension
    API.
43. As a Knox maintainer, I want the built-in provider set to remain closed for
    now, so that provider architecture can mature without also becoming a plugin
    system.
44. As a Knox maintainer, I want cross-platform Codex auth support aligned with
    Knox's current Claude support expectations, so that Codex is not treated as
    a second-class provider.
45. As a Knox maintainer, I want good tests around provider behavior, so that
    adding Codex validates the abstraction instead of weakening confidence in
    the engine.

## Implementation Decisions

### Core architecture

- Introduce an internal execution-level provider registry built around a
  `ProviderSpec` abstraction.
- Keep the built-in provider set closed for now. Provider ids are built-in
  values such as `claude` and `codex`, not plugin-defined extensions.
- Resolve provider choice at the CLI/config boundary rather than inside the
  engine.
- Migrate Claude onto the same provider-spec architecture in the same change so
  Knox does not carry two parallel execution paths.

### Execution policy and configuration

- Provider selection is explicit and required.
- Provider may be supplied by CLI flags or by top-level project config.
- There is no runtime default provider.
- Queue items, queue defaults, and GitHub task defaults do not control
  provider selection.
- If provider appears in task-level config surfaces, Knox ignores it and emits a
  warning stating that provider is execution-level only.
- Use one canonical project-config resolver for both single-run and queue
  commands rather than split config loaders.
- `knox init` should help the user create explicit provider configuration rather
  than leaving provider undefined.

### Resolved execution shape

- Separate execution-level provider context from per-task model resolution.
- Resolve execution-level provider context once per invocation.
- This resolved execution context carries the selected provider, provider spec,
  host auth material, provider network host policy, and one-time container prep
  inputs.
- Per-task model resolution remains separate so that queues can vary difficulty
  across items while keeping one provider policy for the invocation.
- The engine should consume resolved execution capabilities rather than raw
  provider ids or provider-specific config strings.

### Provider responsibilities

- `ProviderSpec` owns provider-specific auth discovery, provider-specific host
  declarations, one-time container preparation, agent-provider construction, and
  later difficulty-to-model mapping after the prerequisite migration lands.
- Auth discovery remains provider-owned to preserve OCP and avoid inventing a
  misleading shared credential abstraction.
- Prompt building remains provider-owned, with small shared helpers allowed for
  common Knox context sections.

### Claude and Codex runtime model

- Codex is integrated by wrapping the official Codex CLI inside the Knox
  container rather than implementing a native Responses API agent loop.
- Codex follows the same broad pattern as Claude: provider-owned prompt
  construction, Knox-owned outer loop orchestration, and provider-owned
  completion detection based on the existing `KNOX_COMPLETE` contract.
- The Knox container remains the only sandbox boundary for both providers.
- Codex runs non-interactively with no internal approval flow inside the Knox
  container.
- Custom prompts remain supported uniformly across providers.

### Authentication

- Codex v1 reuses cached host login state rather than asking the user to supply
  a new API key as the primary path.
- Knox does not own or initiate Codex login; the user authenticates with Codex
  first, then Knox reuses the resulting session.
- Host-side Codex auth discovery supports both file-backed and keyring-backed
  storage modes.
- Host-side Codex auth is read-only.
- Knox discovers Codex auth directly from host storage rather than invoking a
  host Codex binary at runtime.
- Knox copies only the auth material needed for Codex into the container.
- Knox does not inherit host Codex config, profiles, or session preferences.
- If multiple Codex auth sources are present and disagree, Knox fails with a
  clear ambiguity error rather than guessing.

### Container preparation

- Provider-specific container setup happens once per run through a
  `prepareContainer` hook on the provider spec.
- `prepareContainer` returns explicit provider runtime state needed for later
  loop invocations.
- For Codex, provider runtime state includes an ephemeral container-local auth
  home and any other verified provider runtime details needed by the
  `AgentProvider`.
- Use temporary-directory primitives to create ephemeral provider runtime state
  rather than fixed hardcoded temp paths.
- Perform a lightweight provider-specific self-check during container prep so
  missing provider binaries or unreadable auth fail before the first loop.

### Network policy

- Providers declare required hosts; Knox owns DNS/IP resolution and applies the
  resulting egress filter.
- Network policy becomes provider-specific at the hostname-policy level while
  remaining shared Knox infrastructure at the implementation level.
- For Codex, v1 allows the union of OpenAI hosts required by either supported
  cached-auth mode rather than varying host policy by discovered auth mode.

### Base image and custom images

- The Knox base image ships both Claude and Codex runtimes.
- Both provider runtimes are isolated internal installations rather than normal
  user-facing PATH tools.
- Codex is installed using the same general pattern as Claude and tracks the
  latest available CLI release rather than a pinned version.
- Custom images remain user-owned environments. If a user selects a provider
  with a custom image, that image must already contain the corresponding
  provider runtime at the expected canonical location.

### Queue behavior and reporting

- One command invocation uses one execution-level provider.
- Queue discovery mode follows the same one-provider-per-invocation rule.
- Queue resume may continue with a different provider.
- When a resumed queue mixes providers across items, Knox warns and records
  provider provenance per item outcome.
- Provider becomes a first-class field in run results and queue reporting.

### Deep modules to emphasize

- **Provider registry / provider spec** should be the main deep module. It
  encapsulates provider selection, auth discovery, network host policy,
  container setup, and runtime construction behind a stable interface.
- **Resolved execution context** should be a deep module that freezes
  execution-level provider state once and prevents repeated provider discovery
  throughout the stack.
- **Provider-owned prompt builders** should be deep modules that hide provider
  default instructions while consuming a shared Knox prompt context shape.

## Testing Decisions

- Good tests verify external behavior through public contracts, not internal
  implementation details.
- Good tests should not care whether a provider uses one helper or another
  internally as long as the resolved execution behavior is correct.
- Good tests should prefer mocking at explicit seams such as provider specs,
  container handles, command runners, and config resolvers.
- Good tests should validate user-visible policy decisions: config precedence,
  provider requirements, warning behavior, auth ambiguity, result provenance,
  and provider-specific container prep.

### Modules to test

- **Unified project config resolution**
  - Verify top-level provider loading, CLI override behavior, and missing
    provider failures.
  - Verify that provider remains execution-level and is not sourced from queue
    task config.
- **Provider registry / provider resolution**
  - Verify supported provider ids, closed-set behavior, and boundary-time
    resolution into execution capabilities.
- **Resolved execution context**
  - Verify execution-level resolution happens once and is reused consistently
    through preflight and engine execution.
- **Claude provider spec**
  - Verify existing Claude behavior survives the migration onto the new
    provider-spec path.
- **Codex provider spec**
  - Verify host auth discovery, auth ambiguity errors, host-config exclusion,
    allowed-host declarations, and container-prep outputs.
- **Provider-specific auth discovery**
  - Verify file-backed and keyring-backed discovery paths and cross-platform
    behavior using fakes at the storage boundary.
- **Provider-specific container preparation**
  - Verify auth materialization, temp-home creation, ownership/readability, and
    lightweight self-check behavior.
- **Claude and Codex agent providers**
  - Verify prompt construction, shared Knox context injection, custom prompt
    behavior, completion-signal detection, and command invocation shape.
- **CLI behavior**
  - Verify explicit provider requirement, summary output, warnings for ignored
    task-level provider fields, and init-time provider capture behavior.
- **Queue behavior**
  - Verify one-provider-per-invocation policy, ignored task-level provider
    warnings, and mixed-provider resume provenance.
- **Result and report formatting**
  - Verify provider is surfaced in run summaries and queue outcomes.
- **Image/runtime integration**
  - Verify the base image contains both provider runtimes and that custom-image
    validation fails clearly when the selected provider runtime is absent.

### Prior art

- Existing agent-runner tests provide the pattern for validating loop behavior
  through mocked providers.
- Existing Claude provider tests provide the pattern for verifying prompt
  construction and completion detection through a mocked container handle.
- Existing queue orchestrator and queue config tests provide the pattern for
  config precedence, defaults layering, and queue-state behavior.
- Existing auth tests provide the pattern for platform-specific credential
  resolution behavior.
- Existing image-manager and runtime smoke tests provide the pattern for
  container/image validation and end-to-end runtime wiring.

## Out of Scope

- The difficulty migration itself. This PRD assumes the prerequisite difficulty
  work has already landed.
- Any continued public support for the old task-level `model` field.
- An `OPENAI_API_KEY` fallback path for Codex. That should be tracked as a
  follow-up issue or PRD item.
- Public provider plugins or third-party provider registration.
- Making provider-spec internals part of the stable exported library API.
- Native OpenAI Responses API orchestration in Knox instead of the official
  Codex CLI.
- Host-side Codex login, device-auth orchestration, or other interactive auth
  bootstrapping owned by Knox.
- Synchronizing refreshed Codex credentials back to the host after a run.
- Inheriting arbitrary host Codex config into the container.
- Provider-specific base-image lineages or automatic runtime injection into
  arbitrary custom images.
- Non-interactive `knox init` behavior when prompting is unavailable and no
  provider flag is supplied.

## Further Notes

- This PRD depends on the prerequisite difficulty migration so that task-level
  configuration remains provider-agnostic.
- It also fulfills the deferred registry/factory step that earlier provider
  architecture work postponed until Knox had multiple real LLM providers.
- The design intentionally validates the provider abstraction with a second real
  agent runtime while avoiding a broader plugin system.
- The biggest implementation unknowns are provider-specific discovery details
  for Codex auth storage across host platforms and the exact container/runtime
  integration details that should be verified against the live Codex CLI during
  implementation.
