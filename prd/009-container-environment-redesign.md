# PRD 009: Container Environment Redesign

## Problem Statement

Knox runs Claude Code inside Docker containers, and users need to configure the
environment those containers provide (language runtimes, system tools, project
dependencies). Today this is done via a raw `setup` shell command that runs
inside the container before the agent starts. This approach has several
problems:

1. **Leaky abstraction.** Users must know the base image is Ubuntu 24.04, that
   `apt-get` is available, and what's pre-installed. When the base image changed
   from Node to Ubuntu, existing setup commands broke.
2. **No per-item environments.** The `setup` field exists on `QueueItem` in the
   type schema but is never used — only queue-level `defaults.setup` is applied.
   Different jobs in the same queue cannot have different environments.
3. **Fragile coupling.** Claude Code's Node.js runtime is on the user's PATH. If
   a setup command or task modifies Node (e.g., installs a different version
   globally), Claude Code can break.
4. **Poor error experience.** Setup failures produce cryptic Docker/apt errors
   with no guidance on what went wrong or how to fix it.

Users need a way to declare what their tasks need (Python, Rust, Deno, etc.)
without managing Docker internals, while power users need an escape hatch for
fully custom images.

## Solution

Replace the raw `setup` command with a two-tier environment configuration model:

1. **Declarative features.** Knox ships a set of maintained "features" — named,
   versioned language runtimes (e.g., `python: "3.12"`, `rust: "1.78"`) that
   Knox knows how to install on its base image. Users declare what they need;
   Knox handles the how. Features are composable — a task can request Python +
   Deno + Rust and Knox stacks them.

2. **Custom image escape hatch.** Power users who need full control specify
   `image: my-org/custom:latest` and bring their own Docker image. Knox
   validates that it meets requirements (Claude Code, git, etc.) but otherwise
   runs it as-is.

Additionally:

- Claude Code's Node.js runtime is isolated to `/opt/claude/`, off the user's
  PATH, so it cannot conflict with user-installed runtimes.
- The `setup` field is renamed to `prepare` to clarify its purpose:
  project-specific commands (like `pip install -r requirements.txt`) that run
  after features are installed.
- Environment configuration is supported at both queue defaults and per-item
  level, with per-item replacing (not merging) defaults.

## User Stories

1. As a queue author, I want to declare that my tasks need Python 3.12, so that
   I don't have to write `apt-get install` commands or know the base OS.
2. As a queue author, I want to declare multiple language runtimes (e.g.,
   Python + Deno) for a single task, so that my agent can work across languages.
3. As a queue author, I want to specify a feature without a version (e.g., just
   `python`), so that I get a sensible default without looking up version
   numbers.
4. As a queue author, I want to set default features at the queue level, so that
   all items inherit the same environment without repeating configuration.
5. As a queue author, I want to override the environment for a specific item, so
   that one task in a mixed queue can use a different runtime than the rest.
6. As a queue author, I want per-item overrides to fully replace queue defaults
   (not merge), so that I have a clear mental model of what environment an item
   gets.
7. As a queue author, I want to run a project-specific `prepare` command (e.g.,
   `pip install -r requirements.txt`) after features are installed, so that my
   project dependencies are ready before the agent starts.
8. As a queue author, I want to use `prepare` with or without features, so that
   I can install project dependencies on the bare base image if no runtime
   features are needed.
9. As a power user, I want to specify a custom Docker image via `image:`, so
   that I have full control over the container environment when Knox's features
   aren't sufficient.
10. As a power user, I want to use `image:` with a `prepare` command, so that I
    can layer project-specific setup onto my custom base image.
11. As a power user, I want clear documentation of what my custom image must
    include (Claude Code prerequisites), so that I can build a compatible image
    without guessing.
12. As a queue author, I want Knox to reject a configuration that specifies both
    `features` and `image`, so that I catch misconfiguration early rather than
    getting undefined behavior.
13. As a queue author, I want Knox to validate feature names and versions before
    building anything, so that I get an instant, helpful error instead of a
    cryptic Docker build failure.
14. As a queue author, I want Knox to suggest using the `image:` escape hatch
    when my requested version isn't supported, so that I have a clear path
    forward.
15. As a queue author who previously used `setup`, I want a clear validation
    error telling me to use `prepare` instead, so that I can migrate quickly
    without reading changelogs.
16. As a Knox user, I want Claude Code's Node.js to be isolated from my
    environment, so that installing a different Node version for my tasks
    doesn't break the agent.
17. As a Knox user, I want the `node` feature to install via nvm, so that it
    coexists with Claude Code's system Node without conflict.
18. As a Knox user, I want feature combinations to be cached as Docker images,
    so that subsequent runs with the same features start instantly.
19. As a Knox user, I want the cache key to include all inputs (Dockerfile,
    install scripts, feature versions, prepare command), so that any change to
    any input automatically invalidates the cache.
20. As a Knox user, I want `knox features list` to show all available features
    and their supported versions, so that I can discover what's available
    without reading source code.
21. As a Knox user, I want `knox cache clear` to remove all cached images, so
    that I can recover from stale or corrupted caches.
22. As a Knox user, I want the base image to ship with no user-facing language
    runtimes by default, so that my environment is exactly what I declared —
    nothing more.
23. As a Knox user, I want feature install failures to fail fast and discard
    partial work, so that I don't end up with a half-built cached image.
24. As a queue author running `knox run`, I want to specify features and prepare
    in CLI flags or task config, so that single-task execution also benefits
    from the new environment model.

## Implementation Decisions

### New modules

- **Feature Registry:** A module that encapsulates feature discovery, metadata
  loading, and version validation. Loads feature metadata from the in-repo
  `features/` directory. Provides methods to list all features, resolve declared
  features (filling in default versions), and validate feature declarations
  (unknown features, unsupported versions). This is the single source of truth
  for what features exist.

- **Feature Install Scripts:** Six features shipped at launch — `python`,
  `node`, `deno`, `go`, `rust`, `ruby`. Each feature is a directory containing
  an `install.sh` script and a `metadata.json` file. The install script receives
  the version as its first argument, runs as root, must be idempotent, and exits
  non-zero on failure. The metadata file contains `name`, `description`,
  `defaultVersion`, `supportedVersions` (explicit allowlist), and `provides`
  (list of binaries added to PATH, used for conflict detection at validation
  time).

- **CLI commands:** `knox features list` prints a table of available features
  with their default and supported versions. `knox cache clear` removes all
  `knox-cache:*` Docker images.

### Modified modules

- **ImageManager:** The `ensureSetupImage` method is replaced with a new method
  that accepts resolved features and a prepare command. The build pipeline is:
  base image, then feature install scripts (in alphabetical order by feature
  name for deterministic caching), then prepare command. The cache key is
  computed as
  `sha256(base_dockerfile_content + sorted(feature_name:version:install_script_content) + prepare_command)`,
  truncated to 16 hex characters. All inputs that could change the resulting
  image are included in the hash. For custom images with prepare, the cache key
  is `sha256(image_reference + prepare_command)`. Custom images without prepare
  use the image directly with no caching layer. Build failures fail fast and
  discard all work — no intermediate layer caching.

- **Dockerfile:** Node.js and Claude Code CLI are installed to `/opt/claude/`
  with a dedicated PATH. Node is removed from the default user PATH entirely.
  The base image becomes Ubuntu 24.04 + git + curl + ca-certificates +
  iptables + apt-utils + unzip + isolated Claude Code. No user-facing language
  runtimes.

- **Queue types:** The `setup` field is removed from both `QueueItem` and
  `QueueDefaults`. Three new fields are added: `features` (array of string or
  key-value pairs), `prepare` (string), and `image` (string). All fields are
  optional and readonly.

- **Validation:** New validation rules: `features` and `image` are mutually
  exclusive (error if both specified at the same config level). Feature names
  and versions are validated against the Feature Registry. The `setup` field is
  rejected with a migration error: "The `setup` field has been renamed to
  `prepare`. Please update your configuration." The `provides` field in feature
  metadata is used to detect binary conflicts at validation time.

- **Markdown task parser:** Frontmatter parsing updated to recognize `features`,
  `prepare`, and `image` instead of `setup`. Unknown field warnings continue to
  work.

- **Orchestrator:** Currently resolves a single image globally via
  `ImageManager.ensureSetupImage(defaults.setup)`. Updated to resolve the
  environment per-item: for each item, determine its effective environment
  config (item-level overrides or queue defaults), build/cache the appropriate
  image via ImageManager, and pass the resolved image to the engine. Items with
  identical environment configs will naturally share cached images.

- **ContainerSession / Engine:** All references to the `claude` binary updated
  to use the absolute path `/opt/claude/bin/claude`. No other changes needed —
  the container lifecycle, network restriction, and workspace setup remain the
  same.

### Configuration shape

Queue defaults (`_defaults.yaml`):

```yaml
features:
  - python: "3.12"
  - deno
prepare: "pip install -r requirements.txt"
```

Per-item frontmatter (replaces defaults entirely when specified):

```yaml
---
features:
  - rust: "1.78"
prepare: "cargo fetch"
---
```

Custom image escape hatch:

```yaml
image: my-org/custom:latest
prepare: "npm install"
```

Valid combinations at any config level: features only, features + prepare, image
only, image + prepare, prepare only, nothing. Features and image together is a
validation error.

### Feature install script contract

- Receives version as first argument
- Runs as root in the container
- Must be idempotent
- Exits non-zero on failure
- Installs to non-overlapping paths (e.g., `/usr/local/go`, `~/.rustup`,
  `~/.deno`)
- The `node` feature specifically installs via nvm to coexist with Claude Code's
  system Node at `/opt/claude/`

### Cache invalidation

Fully automatic. Any change to any input — base Dockerfile content, feature
install script content, feature version, prepare command — produces a different
hash and triggers a rebuild. No manual cache versioning needed.
`knox cache clear` exists as a manual escape hatch.

## Testing Decisions

Tests should verify external behavior through module interfaces, not
implementation details. Mock the container runtime where possible to keep tests
fast and deterministic.

### Modules to test

- **Feature Registry:** Validate that it correctly lists available features,
  resolves default versions for bare feature names, rejects unknown features,
  rejects unsupported versions, and detects binary conflicts via the `provides`
  field. Test metadata loading and error cases.

- **ImageManager:** Validate cache key determinism (same inputs produce same
  tag), cache busting (changing any input — feature version, install script
  content, prepare command — produces a different tag), correct build ordering
  (features sorted alphabetically), and that custom image + prepare produces a
  different cache key than features + prepare.

- **Validation:** Validate mutual exclusivity rejection (features + image
  together), `setup` migration error message, feature version validation errors
  with helpful messages, and that valid combinations pass validation.

- **Markdown Task Parser:** Validate parsing of new frontmatter fields
  (`features` as array of strings and key-value pairs, `prepare` as string,
  `image` as string), rejection of `setup` field, and unknown field warnings.

### Prior art

Existing tests in the codebase follow these patterns: Deno test framework, mock
runtime objects for image manager tests, `@std/assert` for assertions, temp
directory fixtures for file-based tests. New tests should follow the same
conventions.

## Out of Scope

- **User-contributed / third-party features.** The feature system uses a
  consistent interface (`install.sh` + `metadata.json`) that could support
  external features in the future, but the initial implementation only supports
  in-repo Knox-maintained features.
- **OCI-based feature distribution.** No registry, no remote feature fetching.
  Features ship with Knox.
- **Intermediate layer caching.** If a multi-feature build fails partway
  through, the entire build is discarded. No caching of partial results.
- **Feature dependencies.** Features do not declare dependencies on other
  features. Each install script is self-contained.
- **Private registry authentication in Knox config.** Users handle Docker
  registry auth via host `docker login` and credential helpers.
- **Features on custom images.** Features and `image:` are mutually exclusive.
  You cannot layer Knox features onto a custom image.
- **Additional features beyond the initial six.** More features (java, dotnet,
  php, bun, etc.) can be added later using the same interface.

## Further Notes

- Knox is pre-1.0 with a small user base, so the `setup` → `prepare` rename is a
  hard break with a clear migration error rather than a soft deprecation.
- The alphabetical sorting of features for cache key computation means
  `[python, deno]` and `[deno, python]` produce the same cached image.
  Declaration order does not matter.
- The `/opt/claude/` isolation pattern means the base image no longer has any
  user-facing runtime. This is intentional — it ensures the user's environment
  is exactly what they declared, with no hidden pre-installed tools that might
  change between Knox versions.
