# PRD 015: Split Prepare into envSetup and projectSetup

## Problem Statement

Knox runs a `prepare` command during Docker image building to set up
dependencies before the agent starts. However, the image build phase has no
access to the project's source code — source is only copied into the container
later, during `ContainerSession.create()`. This means any `prepare` command that
references project files (e.g., `deno install`, `pip install -r
requirements.txt`, `cargo fetch`, `npm install`) fails with a "module not found"
error.

The PRD that introduced `prepare` (PRD 009) explicitly described it as
"project-specific commands like `pip install -r requirements.txt`" — commands
that inherently need source files. The current implementation contradicts its own
design intent.

Users who hit this get an opaque Docker error with no guidance. The only
workaround is to avoid source-dependent commands in `prepare` entirely, which
defeats the purpose of the field.

## Solution

Split the single `prepare` hook into two distinct hooks with clear lifecycle
positions:

1. **`envSetup`** — Runs during image building. No source code available. Result
   is cached in a Docker image. Use for environment-level setup that does not
   depend on project files (e.g., `apt-get install -y jq`, system-level
   configuration). Runs as root.

2. **`projectSetup`** — Runs inside the container after source code is copied in,
   but before network is restricted. Has full network access and full source tree.
   Runs every container creation (not cached). Use for project-specific dependency
   installation (e.g., `deno install`, `pip install -r requirements.txt`, `cargo
   fetch`). Runs as the `knox` user.

The existing `prepare` field is removed entirely (hard break, no migration path).

## User Stories

1. As a queue author, I want to run `deno install` with access to my `deno.json`,
   so that Deno's JSR dependencies are cached before the network is restricted.
2. As a queue author, I want to run `pip install -r requirements.txt` with access
   to my source tree, so that Python dependencies are installed before the agent
   starts.
3. As a queue author, I want to run `npm install` with access to my
   `package.json`, so that Node dependencies are resolved before network
   restriction.
4. As a queue author, I want to run `cargo fetch` with access to my `Cargo.toml`,
   so that Rust crate downloads complete before network restriction.
5. As a queue author, I want to install system-level tools via `envSetup` that get
   cached in the Docker image, so that subsequent runs with the same environment
   start instantly.
6. As a queue author, I want `envSetup` to be cached in the Docker image alongside
   features, so that I don't pay the cost of re-running environment setup on every
   container creation.
7. As a queue author, I want `projectSetup` to run as the `knox` user, so that
   installed dependencies are owned by the same user that runs the agent.
8. As a queue author, I want `projectSetup` failure to fail the item and block
   dependents, so that the agent doesn't start in a broken environment.
9. As a queue author, I want to use `envSetup` and `projectSetup` together, so
   that I can install system tools at the image level and project dependencies at
   the container level.
10. As a queue author, I want to use `projectSetup` without `envSetup` or
    features, so that I can install project dependencies on the bare base image.
11. As a queue author, I want to use `envSetup` without features, so that I can
    run custom image-level commands without declaring formal feature dependencies.
12. As a queue author, I want to set `envSetup` and `projectSetup` at the queue
    defaults level, so that all items inherit the same setup without repeating
    configuration.
13. As a queue author, I want per-item `projectSetup` to replace the default
    `projectSetup` independently of image-level config, so that overriding one
    does not affect the other.
14. As a queue author, I want per-item `envSetup`/`features`/`image` to replace
    the default image config as a group (existing behavior), so that the mental
    model stays consistent.
15. As a `knox run` user, I want `--env-setup` and `--project-setup` CLI flags, so
    that single-task execution also benefits from the split hooks.
16. As a queue author using the GitHub Issues source, I want `envSetup` and
    `projectSetup` in issue body frontmatter, so that the same config works across
    all queue sources.
17. As a queue author, I want `projectSetup` to have full network access, so that
    it can download dependencies from registries before the network is locked down.

## Implementation Decisions

### Removed concepts

- The `prepare` field is removed from all types, validation, parsers, CLI flags,
  and image building. This is a hard break with no migration path or deprecation
  warning, consistent with the pre-1.0 precedent set by the `setup` → `prepare`
  rename in PRD 009.
- The `setup` migration error is also removed — it referenced `prepare` which no
  longer exists.

### Modified modules

- **Queue types (`EnvironmentConfig`, `QueueItem`, `QueueDefaults`):**
  `EnvironmentConfig` changes from `{ features?, prepare?, image? }` to
  `{ features?, envSetup?, image? }`. `QueueItem` and `QueueDefaults` get both
  `envSetup` (via `EnvironmentConfig`) and a new `projectSetup?: string` field.
  `projectSetup` is not part of `EnvironmentConfig` because it is not an image
  concern.

- **ImageManager:** `FeatureImageOptions.prepare` is renamed to
  `FeatureImageOptions.envSetup`. `CustomImageOptions.prepare` is renamed to
  `CustomImageOptions.envSetup`. All internal references to `prepare` in the build
  pipeline, cache key computation, and commit messages are renamed to `envSetup`.
  Behavior is unchanged — `envSetup` runs as root during image build, result is
  cached.

- **ContainerSession:** `ContainerSessionOptions` gains a
  `projectSetup?: string` field. In `ContainerSession.create()`, if
  `projectSetup` is present, it runs via `runtime.exec()` after the `chown` step
  and before `restrictNetwork()`. It runs as the `knox` user (no `user` override)
  with `workdir: /workspace`. Non-zero exit throws an `Error`, which is caught by
  `Knox.run()` as a `phase: "container"` failure.

- **Knox engine (`KnoxEngineOptions`):** Gains a `projectSetup?: string` field.
  `Knox.run()` passes it through to `ContainerSessionOptions`.

- **Orchestrator:** `projectSetup` follows the same pattern as `check` — resolved
  from item or defaults (`item.projectSetup ?? defaults.projectSetup`) and passed
  to `KnoxEngineOptions`. `envSetup` replaces `prepare` in the `imageResolver`
  call and in the per-item environment override detection.

- **Validation:** Remove the `setup` migration error and all `prepare` references.
  The `features`/`image` mutual exclusivity check remains unchanged. `envSetup`
  replaces `prepare` in the item construction.

- **Markdown task parser:** `KNOWN_FIELDS` replaces `prepare` with `envSetup` and
  `projectSetup`. `REMOVED_FIELDS` is emptied (no migration messages). Item
  mapping replaces `fm.prepare` with `fm.envSetup` and `fm.projectSetup`.

- **CLI:** The `--prepare` flag on `knox run` is replaced with `--env-setup` and
  `--project-setup`. `resolveDefaultsImage()` and `createImageResolver()` pass
  `envSetup` instead of `prepare` to `ImageManager`. The `knox run` command
  passes `projectSetup` to `KnoxEngineOptions` instead of to `ImageManager`. CLI
  help text updated.

### Configuration shape

Queue defaults:

```yaml
features:
  - deno
envSetup: "apt-get install -y jq"
projectSetup: "deno install"
```

Per-item frontmatter:

```yaml
---
features:
  - python: "3.12"
envSetup: "apt-get install -y libpq-dev"
projectSetup: "pip install -r requirements.txt"
---
```

Custom image:

```yaml
image: my-org/custom:latest
envSetup: "custom-tool setup"
projectSetup: "npm install"
```

### Lifecycle sequence (after this change)

1. Image build: base image → features → `envSetup` → commit + cache
2. Container create → copy source → chown → **`projectSetup`** → restrict network → git verify → git exclude
3. Agent loop: claude invocations + check commands

## Testing Decisions

Tests should verify external behavior through module interfaces, not
implementation details. Mock the container runtime where possible to keep tests
fast and deterministic.

### Modules to test

- **ImageManager:** Verify that `envSetup` replaces `prepare` in the build
  pipeline. Cache key computation with `envSetup`. Feature + `envSetup`
  execution order. `ensureCustomImage` with `envSetup`. Existing cache
  determinism tests updated for new field name.

- **ContainerSession:** Verify that `projectSetup` runs after chown and before
  `restrictNetwork()` in the call sequence. Verify it runs without a `user`
  override (knox user). Verify that failure throws and cleans up the container.
  Verify that omitting `projectSetup` preserves the existing call sequence.

- **Validation:** Verify that `envSetup` and `projectSetup` are accepted on both
  defaults and items. Verify `features`/`image` mutual exclusivity still works.
  Remove tests for `setup` and `prepare` migration errors.

- **Markdown task parser:** Verify parsing of `envSetup` and `projectSetup` from
  frontmatter. Verify unknown field warnings still work. Remove `prepare`-related
  test fixtures.

### Prior art

Existing tests in the codebase follow these patterns: Deno test framework, mock
runtime objects for image manager and container session tests, `@std/assert` for
assertions. New tests should follow the same conventions.

## Out of Scope

- **Caching `projectSetup` results.** `projectSetup` runs every container
  creation. Package managers have their own caching mechanisms. Adding a Knox-level
  cache for post-source commands is a future optimization.
- **Running `projectSetup` as root.** If a command needs root, it belongs in
  `envSetup` or a feature. `projectSetup` always runs as the `knox` user.
- **Migration path for `prepare`.** Knox is pre-1.0. The field is removed with no
  deprecation warning or alias.
- **New features to replace common `envSetup` patterns.** If users frequently use
  `envSetup` for the same system tools, those should become features in a future
  PRD.

## Further Notes

- The `SourceProvider.prepare()` method is unrelated to this change. It refers to
  preparing the source tree on the host (shallow clone, etc.) and is not renamed.
- The GitHub Issues queue source delegates to the Markdown task parser for
  frontmatter parsing, so updating the parser covers both queue sources
  automatically.
- `envSetup` without features continues to trigger image building and caching,
  matching the current behavior of `prepare` without features.
- The `ensureSetupImage` legacy method on `ImageManager` can be removed as part of
  this work since it forwarded to `prepare`-based logic.
