# Plan: Container Environment Redesign

> Source PRD: prd/009-container-environment-redesign.md

## Architectural decisions

Durable decisions that apply across all phases:

- **Claude Code isolation path**: `/opt/claude/` — Node.js and Claude Code CLI installed here, off the user's PATH. Engine invokes `/opt/claude/bin/claude` via absolute path.
- **Feature directory structure**: `features/{name}/install.sh` + `metadata.json` in the Knox repo root. Each install script receives version as first argument, runs as root, must be idempotent.
- **Feature metadata schema**: `{ name, description, defaultVersion, supportedVersions (explicit allowlist), provides (binary names for conflict detection) }`
- **Config fields**: `features` (array of string or key-value), `prepare` (string), `image` (string) replace the old `setup` field on both `QueueItem` and `QueueDefaults`.
- **Mutual exclusivity**: `features` and `image` cannot coexist at any config level. Validation error if both specified.
- **Per-item semantics**: Per-item environment config replaces queue defaults entirely (no merging).
- **Cache key**: `sha256(base_dockerfile + sorted(feature_name:version:install_script_content) + prepare_command)` truncated to 16 hex chars. Tag format: `knox-cache:{hash}`. For custom image + prepare: `sha256(image_ref + prepare_command)`.
- **Build pipeline order**: Base image → features (alphabetical by name) → prepare command → commit + cache. Fail fast, discard on failure.
- **Initial features**: python, node (via nvm), deno, go, rust, ruby.
- **`setup` migration**: Hard break. `setup` field rejected at validation with error: "The `setup` field has been renamed to `prepare`. Please update your configuration."

---

## Phase 1: Isolate Claude Code to /opt/claude/

**User stories**: 16

### What to build

Move Claude Code's Node.js runtime and CLI binary out of the user's PATH and into an isolated directory. The base Dockerfile installs Node.js and Claude Code to `/opt/claude/` instead of the system-wide `/usr/local/`. The engine's agent runner switches from invoking `claude` by name to invoking `/opt/claude/bin/claude` via absolute path. The base image ships with no user-facing language runtime on PATH — only system tools (git, curl, etc.).

After this phase, `knox run` works exactly as before, but Claude Code is invisible to user processes inside the container. This is the foundation that makes per-user Node versions (and all other features) safe.

### Acceptance criteria

- [ ] Dockerfile installs Node.js and Claude Code CLI to `/opt/claude/` with `/opt/claude/bin` not on the default user PATH
- [ ] Agent runner invokes Claude via absolute path `/opt/claude/bin/claude` in all execution paths (main loop, commit nudge)
- [ ] `knox run` completes successfully with the updated base image (agent can execute tasks, produce git bundles)
- [ ] Running `node --version` inside the container as the `knox` user returns "command not found" (Node not on user PATH)
- [ ] Running `/opt/claude/bin/claude --version` inside the container succeeds
- [ ] Existing tests pass with the updated Dockerfile and invocation path

---

## Phase 2: Feature system end-to-end (single feature, queue defaults only)

**User stories**: 1, 3, 7, 8, 13, 14, 15, 18, 19, 22, 23, 24

### What to build

The core tracer bullet — a thin vertical slice through every layer that proves the feature system works end-to-end with a single feature (python) at the queue-defaults level.

**Feature definition**: Create the python feature with an `install.sh` that installs CPython from the deadsnakes PPA or official source for the requested version, and a `metadata.json` with supported versions and default.

**Feature Registry**: A new module that loads feature metadata from the `features/` directory, validates declared features against known names and supported versions, resolves bare feature names to their default version, and detects binary conflicts via the `provides` field. Returns clear error messages that suggest the `image:` escape hatch when a version isn't supported.

**Type changes**: Replace `setup` with `features`, `prepare`, and `image` on both `QueueItem` and `QueueDefaults`.

**Validation**: Reject the `setup` field with a migration error. Validate feature names and versions against the Feature Registry before any Docker work. Reject configs that specify both `features` and `image`.

**Markdown parser**: Recognize `features`, `prepare`, and `image` in frontmatter instead of `setup`.

**ImageManager**: New method that accepts resolved features and a prepare command. Build pipeline: base image → run each feature's install script in alphabetical order → run prepare command → commit and cache. Cache key includes all inputs (Dockerfile content, install script contents, feature versions, prepare command). If no features or prepare, return the base image.

**CLI wiring**: Update `knox run` to accept features/prepare/image instead of `--setup`. Update `knox queue` (all modes) to resolve features from queue defaults and pass the correct image to the orchestrator.

After this phase, a user can write `features: [python: "3.12"]` and `prepare: "pip install flask"` in `_defaults.yaml` and the queue runs with Python available in the container.

### Acceptance criteria

- [ ] `features/python/install.sh` installs the requested Python version and `pip` into the container
- [ ] `features/python/metadata.json` lists supported versions and a default version
- [ ] Feature Registry loads metadata, resolves bare `python` to default version, rejects unknown features, rejects unsupported versions with a message suggesting `image:`
- [ ] `setup` field in queue config or frontmatter produces a validation error with migration instructions
- [ ] `features` and `image` together in the same config level produces a validation error
- [ ] Markdown parser correctly parses `features` (bare strings and key-value), `prepare`, and `image` from frontmatter
- [ ] ImageManager builds a cached image from base + python feature + prepare command
- [ ] Cache key is deterministic: same inputs produce the same tag
- [ ] Cache key changes when any input changes (feature version, install script content, prepare command, Dockerfile)
- [ ] Build failure during feature install or prepare fails fast and discards all work (no partial cache)
- [ ] `knox run` with `--features python:3.12 --prepare "pip install flask"` works end-to-end
- [ ] `knox queue` with `features` and `prepare` in `_defaults.yaml` works end-to-end
- [ ] Feature Registry, ImageManager, validation, and parser tests pass

---

## Phase 3: Custom image escape hatch

**User stories**: 9, 10, 11, 12

### What to build

Wire the `image:` field through the ImageManager and CLI so users can bring their own Docker image. When `image` is specified without `prepare`, Knox uses the image directly (no caching layer). When `image` is specified with `prepare`, Knox runs the prepare command in a temp container from that image, commits and caches the result with key `sha256(image_ref + prepare_command)`.

Document the custom image requirements in the README: what must be installed (Claude Code CLI at `/opt/claude/`, git, a non-root user), how to verify compatibility, and a reference Dockerfile users can extend.

After this phase, `image: python:3.12-slim` works in a queue config (assuming it meets the requirements), and `image: my-base:latest` with `prepare: "npm install"` builds and caches a project-specific layer on top.

### Acceptance criteria

- [ ] `image: <name>` in queue defaults or item frontmatter uses the specified image directly
- [ ] `image: <name>` with `prepare: <cmd>` builds, caches, and reuses a prepared image
- [ ] Cache key for image + prepare is deterministic and distinct from feature-based cache keys
- [ ] Specifying both `features` and `image` at the same config level produces a clear validation error
- [ ] README documents custom image requirements, provides a reference Dockerfile, and explains verification steps
- [ ] `knox run --image <name>` works end-to-end

---

## Phase 4: Per-item environment resolution

**User stories**: 4, 5, 6

### What to build

Update the orchestrator to resolve the environment (features/prepare/image) per-item rather than using a single global image. Currently the CLI resolves one image via `ImageManager.ensureSetupImage(defaults.setup)` and passes it to the orchestrator, which passes it to every engine invocation. After this phase, each item can declare its own environment.

The orchestrator determines each item's effective environment config: if the item declares `features`, `prepare`, or `image`, those replace the queue defaults entirely (no merging). If the item declares nothing, it inherits queue defaults. The orchestrator then resolves the correct image for each item via ImageManager. Items with identical environment configs naturally share the same cached image.

The `image` field on `OrchestratorOptions` changes from a single pre-resolved string to something the orchestrator can resolve per-item using an ImageManager instance.

After this phase, a queue can have items with different environments — one using Python, another using Rust — and each gets the correct container image.

### Acceptance criteria

- [ ] Items without environment config inherit queue defaults
- [ ] Items with `features` declared replace queue defaults entirely (not merge)
- [ ] Items with `image` declared replace queue defaults entirely
- [ ] Two items with identical environment configs share the same cached image (no redundant builds)
- [ ] Two items with different environment configs get different images
- [ ] `prepare` at the item level replaces queue-default `prepare` (not appended)
- [ ] A queue with mixed environments (e.g., one Python item, one Rust item) runs successfully with each item in the correct environment

---

## Phase 5: Remaining features + stacking

**User stories**: 2, 17

### What to build

Add the remaining five features: node, deno, go, rust, ruby. Each gets an `install.sh` + `metadata.json` following the same contract as python.

The node feature is special: it installs via `nvm` into the knox user's profile, ensuring coexistence with Claude Code's system Node at `/opt/claude/`. The nvm-managed node becomes the default `node` on the user's PATH without affecting `/opt/claude/bin/node`.

Verify multi-feature stacking works correctly: declaring `features: [python: "3.12", deno: "2.0", rust: "1.78"]` builds a single image with all three runtimes available. Verify that alphabetical sort produces deterministic cache keys regardless of declaration order. Verify that the `provides` field in metadata correctly detects conflicts (if any two features claim the same binary name).

After this phase, all six features are available and composable.

### Acceptance criteria

- [ ] Each of the six features (python, node, deno, go, rust, ruby) installs correctly in isolation
- [ ] Node feature installs via nvm; `node --version` returns the requested version; `/opt/claude/bin/node --version` returns the system version (different)
- [ ] Multi-feature stacking works: `features: [python, deno, rust]` produces a container with all three runtimes on PATH
- [ ] Declaration order doesn't affect the cache key: `[python, deno]` and `[deno, python]` produce the same cached image
- [ ] All feature install scripts are idempotent (running the build twice produces the same result)
- [ ] Feature metadata lists accurate supported versions and correct `provides` entries

---

## Phase 6: CLI discovery commands

**User stories**: 20, 21

### What to build

Add two new CLI subcommands:

`knox features list` — Reads all feature metadata from the Feature Registry and prints a table showing each feature's name, description, default version, and supported versions. Provides a quick reference so users don't need to read docs or source code to know what's available.

`knox cache clear` — Removes all Docker images tagged with the `knox-cache:` prefix. Prints the number of images removed. This is the manual escape hatch for stale or corrupted caches.

After this phase, users have self-service discovery and cache management from the CLI.

### Acceptance criteria

- [ ] `knox features list` prints all available features with name, default version, and supported versions
- [ ] `knox features list` output is readable and well-formatted (aligned columns or table)
- [ ] `knox cache clear` removes all `knox-cache:*` images
- [ ] `knox cache clear` prints how many images were removed
- [ ] `knox cache clear` succeeds gracefully when no cached images exist
- [ ] Both commands appear in `knox --help` output
