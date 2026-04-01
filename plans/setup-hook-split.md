# Plan: Setup Hook Split (envSetup + projectSetup)

> Source PRD: prd/015-setup-hook-split.md

## Architectural decisions

Durable decisions that apply across all phases:

- **Two hooks, two lifecycle positions**: `envSetup` runs during image build (no
  source, cached in Docker image, runs as root). `projectSetup` runs in
  `ContainerSession.create()` after source copy and chown, before
  `restrictNetwork()` (has source, full network, runs as knox user, not cached).
- **Hard break**: `prepare` and `setup` are removed entirely. No migration errors,
  no aliases.
- **`EnvironmentConfig` scope**: Contains `{ features?, envSetup?, image? }`.
  `projectSetup` is NOT part of `EnvironmentConfig` because it is not an image
  concern.
- **Override semantics**: `envSetup`/`features`/`image` replace as a group
  (existing behavior). `projectSetup` replaces independently.
- **`projectSetup` failure**: Fatal for the item. Throws during
  `ContainerSession.create()`, surfaces as `phase: "container"` failure.
  Dependents are blocked via existing orchestrator logic.
- **CLI flags**: `--env-setup` and `--project-setup` replace `--prepare` on
  `knox run`.

---

## Phase 1: Rename `prepare` → `envSetup` on ImageManager and types

**User stories**: 5, 6, 11

### What to build

Pure rename of the existing `prepare` config field to `envSetup` across all type
definitions and the ImageManager build pipeline. No new behavior — the field
moves to its new name, execution logic stays identical (runs during image build,
as root, cached in Docker image). `EnvironmentConfig.prepare` becomes
`EnvironmentConfig.envSetup`. `FeatureImageOptions.prepare` and
`CustomImageOptions.prepare` become `.envSetup`. All internal ImageManager
references (cache key computation, exec calls, commit messages) update
accordingly. The legacy `ensureSetupImage` method is removed.

Update all ImageManager tests to use `envSetup` instead of `prepare`.

### Acceptance criteria

- [ ] `EnvironmentConfig` has `envSetup` instead of `prepare`
- [ ] `FeatureImageOptions` and `CustomImageOptions` use `envSetup`
- [ ] `ImageManager.ensureFeatureImage()` reads and executes `envSetup`
- [ ] `ImageManager.ensureCustomImage()` reads and executes `envSetup`
- [ ] Cache key computation includes `envSetup` (not `prepare`)
- [ ] `ensureSetupImage` legacy method removed
- [ ] All ImageManager tests pass with `envSetup`
- [ ] `deno task check` passes with no type errors

---

## Phase 2: Add `projectSetup` to ContainerSession and Knox engine

**User stories**: 1, 2, 3, 4, 7, 8, 9, 10, 17

### What to build

Add `projectSetup?: string` to `ContainerSessionOptions`. In
`ContainerSession.create()`, after the chown step and before `restrictNetwork()`,
execute `projectSetup` via `runtime.exec()` with `["sh", "-c", projectSetup]` in
the `/workspace` workdir. No `user` override (runs as knox user). Non-zero exit
throws an Error and cleans up the container.

Add `projectSetup?: string` to `KnoxEngineOptions`. `Knox.run()` passes it
through to `ContainerSession.create()` options.

Add ContainerSession tests verifying: the exec call appears in the correct
position in the call sequence (after chown, before restrictNetwork), no user
override is set, omitting projectSetup preserves the original call sequence, and
failure throws and triggers container cleanup.

### Acceptance criteria

- [ ] `ContainerSessionOptions` has `projectSetup?: string`
- [ ] `projectSetup` executes after chown and before `restrictNetwork()` in
      `ContainerSession.create()`
- [ ] `projectSetup` runs as the knox user (no user override)
- [ ] `projectSetup` failure throws and cleans up the container
- [ ] `KnoxEngineOptions` has `projectSetup?: string`
- [ ] `Knox.run()` passes `projectSetup` to `ContainerSessionOptions`
- [ ] ContainerSession tests verify call sequence with `projectSetup`
- [ ] ContainerSession tests verify omitting `projectSetup` preserves original
      sequence
- [ ] ContainerSession tests verify failure behavior
- [ ] `deno task check` passes with no type errors

---

## Phase 3: Thread `projectSetup` through orchestrator and parsers

**User stories**: 12, 13, 14, 16

### What to build

Add `projectSetup?: string` to `QueueItem` and `QueueDefaults` (not via
`EnvironmentConfig` — it is a direct field on both types).

In the orchestrator's `runItem()`, resolve `projectSetup` the same way `check` is
resolved: `item.projectSetup ?? defaults.projectSetup`. Pass it to
`KnoxEngineOptions`. Update the per-item environment override detection to use
`envSetup` instead of `prepare`.

In the markdown task parser, replace `prepare` with `envSetup` and
`projectSetup` in `KNOWN_FIELDS`. Remove `REMOVED_FIELDS` entirely (no migration
messages). Update the item mapping to spread `fm.envSetup` and
`fm.projectSetup`.

In validation, remove the `setup` migration error and `prepare` references.
Replace `prepare` with `envSetup` in item construction. The `features`/`image`
mutual exclusivity check is unchanged.

Update parser and validation tests.

### Acceptance criteria

- [ ] `QueueItem` and `QueueDefaults` have `projectSetup?: string`
- [ ] Orchestrator resolves `projectSetup` from item/defaults and passes to engine
- [ ] Orchestrator per-item env detection uses `envSetup` instead of `prepare`
- [ ] Markdown parser recognizes `envSetup` and `projectSetup` in `KNOWN_FIELDS`
- [ ] `prepare` removed from `KNOWN_FIELDS`
- [ ] `REMOVED_FIELDS` emptied (no `setup` migration message)
- [ ] Item mapping uses `fm.envSetup` and `fm.projectSetup`
- [ ] Validation constructs items with `envSetup` instead of `prepare`
- [ ] `setup` migration error removed from validation
- [ ] Parser and validation tests updated and passing
- [ ] `deno task check` passes with no type errors

---

## Phase 4: Update CLI flags

**User stories**: 15

### What to build

Replace the `--prepare` CLI flag on `knox run` with `--env-setup` and
`--project-setup`. Wire `--env-setup` to `ImageManager` (passed to
`ensureFeatureImage` / `ensureCustomImage`). Wire `--project-setup` to
`KnoxEngineOptions` (passed through to `ContainerSession`).

Update `resolveDefaultsImage()` and `createImageResolver()` to pass `envSetup`
instead of `prepare` to `ImageManager`.

Update CLI help text to document both flags with clear descriptions of when to
use each.

### Acceptance criteria

- [ ] `--prepare` flag removed from `knox run`
- [ ] `--env-setup` flag added, wired to `ImageManager`
- [ ] `--project-setup` flag added, wired to `KnoxEngineOptions`
- [ ] `resolveDefaultsImage()` passes `envSetup` to ImageManager
- [ ] `createImageResolver()` passes `envSetup` to ImageManager
- [ ] CLI help text documents both flags
- [ ] `deno task check` passes with no type errors
