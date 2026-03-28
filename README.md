# Knox

Knox runs Claude Code autonomously inside sandboxed Docker containers. Give it a
task and a directory — it copies your code into a container, runs Claude Code in
an iterative loop until the task is complete, and gives you back the result as a
git branch.

Run a single task, or define a queue of tasks — as a YAML manifest, a directory
of Markdown files, or GitHub Issues — with dependencies and groups. Knox
schedules them as a DAG, runs them concurrently, and produces one branch per
group with stacked commits.

The agent has full access inside the container but zero access to your host
filesystem or network. The container is the permission boundary.

## Install

Requires [Deno](https://deno.land) and [Docker](https://www.docker.com).

```sh
# Run directly
deno run --allow-run --allow-read --allow-write --allow-env --allow-net src/cli.ts run --task "..." --dir .

# Or compile to a standalone binary
deno task compile
./knox run --task "..." --dir .
```

## Usage

Knox has four subcommands: `run`, `queue`, `features`, and `cache`.

### Single task — `knox run`

```sh
# Basic usage
knox run --task "Add input validation to the signup form" --dir ./my-project

# With features and verification
knox run --task "Fix the flaky pagination test" \
  --dir ./my-project \
  --features "node:22" \
  --prepare "npm install" \
  --check "npm test" \
  --max-loops 5

# Multiple features
knox run --task "Build the data pipeline" \
  --dir ./my-project \
  --features "python:3.12,deno" \
  --prepare "pip install -r requirements.txt"

# Custom Docker image
knox run --task "Fix the legacy service" \
  --dir ./my-project \
  --image python:3.12-slim \
  --prepare "pip install flask"

# Custom model and resource limits
knox run --task "Refactor auth middleware to use JWT" \
  --dir ./my-project \
  --model opus \
  --cpu 4 \
  --memory 8g

# Pass environment variables
knox run --task "Update API client" \
  --dir ./my-project \
  --env DATABASE_URL=postgres://localhost/dev \
  --env FEATURE_FLAG=true
```

#### Run options

| Flag               | Default         | Description                                                      |
| ------------------ | --------------- | ---------------------------------------------------------------- |
| `--task`           | _(required)_    | Task description for the agent                                   |
| `--dir`            | `.`             | Source directory to work on                                       |
| `--model`          | `sonnet`        | Claude model to use                                              |
| `--features`       | —               | Features to install (e.g., `python:3.12,deno`) — see [Container Environment](#container-environment) |
| `--prepare`        | —               | Prepare command run with network access (e.g., `pip install flask`) |
| `--image`          | —               | Custom Docker image (mutually exclusive with `--features`)       |
| `--check`          | —               | Verification command run after agent signals completion          |
| `--max-loops`      | `10`            | Maximum agent loop iterations                                    |
| `--env`            | —               | Environment variable as `KEY=VALUE` (repeatable)                 |
| `--prompt`         | —               | Path to custom prompt file                                       |
| `--cpu`            | —               | CPU limit (e.g., `2`)                                            |
| `--memory`         | —               | Memory limit (e.g., `4g`)                                        |
| `--skip-preflight` | `false`         | Skip preflight checks                                            |
| `--verbose`        | `false`         | Show debug-level messages                                        |
| `--output`         | config/`branch` | Output strategy: `branch` or `pr`                                |
| `--quiet`          | `false`         | Suppress info messages (warnings and errors only)                |

### Queue — `knox queue`

Knox queues are a three-stage pipeline: **Ingest** (load task definitions) →
**Build** (run each task in a container) → **Output** (deliver results as
branches or PRs).

The `--source` flag is required and selects where tasks come from:

```sh
# ── Directory source ────────────────────────────────────────────────

# Run a named queue from .knox/queues/<name>/
knox queue --source directory --name auth-refactor

# Auto-discover and run all queues under .knox/queues/
knox queue --source directory

# Run a YAML queue file
knox queue --source directory --file ./tasks.yaml

# Resume a previous run (skips completed items, retries failed)
knox queue --source directory --name auth-refactor --resume

# ── GitHub source ───────────────────────────────────────────────────

# Run tasks from GitHub Issues labeled 'agent/knox'
knox queue --source github

# ── Common options ──────────────────────────────────────────────────

# Output as PRs instead of branches
knox queue --source directory --output pr

# Verbose with live TUI disabled (plain log lines)
knox queue --source directory --verbose --no-tui
```

#### Queue sources

Knox supports two queue sources: **directory** (local Markdown/YAML files) and
**github** (GitHub Issues). Both produce the same manifest format and run
through the same orchestrator.

##### Directory source

A queue is a directory of Markdown task files under `.knox/queues/`:

```
.knox/queues/api-errors/
├── _defaults.yaml          # optional queue-level defaults
├── lint-rules.md
├── error-types.md
├── refactor-handlers.md
└── error-middleware.md
```

Each `.md` file is one task. The filename (minus `.md`) is the item ID. Use YAML
frontmatter for orchestration metadata and the Markdown body for the task
description:

```markdown
---
dependsOn: error-types
group: api-errors
check: "npm test"
---

Refactor API handlers to use the new error types.

Replace all `throw new Error(...)` calls with the typed error classes
defined in `src/errors/`. Update catch blocks in middleware to match.
```

Frontmatter fields: `dependsOn`, `model`, `features`, `prepare`, `image`,
`check`, `group`, `maxLoops`, `env`, `cpu`, `memory`. Files prefixed with `_`
are skipped (reserved for config).

An optional `_defaults.yaml` provides queue-level defaults — same shape as the
YAML manifest `defaults` key:

```yaml
# _defaults.yaml
model: sonnet
features:
  - node:22
prepare: "npm install"
check: "npm test"
maxLoops: 5
```

Alternatively, a queue can be a single YAML manifest file (see
[YAML format](#yaml-manifest-format) below).

##### GitHub source

With `--source github`, Knox fetches open GitHub Issues labeled `agent/knox`
from the current repository and treats each one as a task. Issue bodies use the
same frontmatter + Markdown format as directory-based tasks:

```markdown
---
model: opus
features:
  - python:3.12
prepare: "pip install -r requirements.txt"
check: "pytest"
maxLoops: 8
---

Refactor the authentication module to use JWT tokens instead of session cookies.
Update all tests to use the new auth flow.
```

Each issue gets an item ID in the format `gh-<number>-<slugified-title>` (e.g.,
`gh-42-refactor-auth-to-jwt`). The slugified title portion is capped at 50
characters.

Knox auto-creates `knox/claimed`, `knox/running`, `knox/failed`, and
`knox/blocked` labels in the repo on first use. Knox never adds or removes the
`agent/knox` label — that's yours to manage.

When a task completes, Knox closes the issue and removes the `knox/claimed`
label. Pull requests in the issue list are automatically filtered out.

Queue-level defaults for the GitHub source are configured in
`.knox/config.yaml`:

```yaml
# .knox/config.yaml
github:
  defaults:
    model: sonnet
    features:
      - node:22
    prepare: "npm install"
    maxLoops: 5
```

#### How queues run

1. **Ingest** — Knox loads task definitions via a Queue Source (Markdown
   directory, YAML file, or GitHub Issues), parses and validates the manifest,
   and builds the dependency DAG.

2. **Build** — The orchestrator generates a queue run ID, resolves shared
   resources (image, credentials, allowed IPs) once, then schedules items:
   - Items with no unmet dependencies are **ready**. Up to `concurrency` items
     run in parallel (default: 1).
   - Each item invokes the Knox engine: container creation, agent loops, bundle
     extraction, branch creation — same as `knox run`.
   - When an item completes, its dependents become ready. When an item fails,
     its transitive dependents are **blocked**.
   - Items in a **group** share a single branch
     (`knox/<group>-<queueRunId>`). Each item builds on its predecessor's
     commits via chained execution.

3. **Output** — After all items finish, Knox delivers results based on the
   output strategy:
   - **`branch`** (default) — No additional action. Branches were created
     during the build stage by the per-item result sink.
   - **`pr`** — Creates a GitHub PR (via `gh` CLI) for each completed branch.
     Grouped items produce one PR per group.

#### Queue state

- **State file** — `.state.yaml` written alongside the manifest (YAML mode),
  inside the queue directory (Markdown mode), or at `.knox/github.state.yaml`
  (GitHub mode). Updated on every status transition (`pending` → `in_progress` →
  `completed` / `failed` / `blocked`).
- **Per-item logs** — Agent output captured to a `.logs/` directory next to the
  queue, one file per item (`<item-id>.log`), regardless of verbosity.
- **Report** — Full JSON printed to stdout with all item outcomes.
- **Resume** — `--resume` reads the existing state file: completed items are
  skipped, failed and blocked items reset to pending.

#### Queue display

If stderr is a TTY, Knox renders a live status table (Queue TUI) with spinners,
phase labels, and elapsed time per item. Use `--no-tui` to fall back to
timestamped log lines. In either mode, `--verbose` shows interleaved agent
output.

#### Queue modes

| Source | Mode | Flags | What it loads |
| ------ | ---- | ----- | ------------- |
| `directory` | Named | `--name my-queue` | Markdown directory at `.knox/queues/my-queue/` |
| `directory` | Discovery | _(no extra flag)_ | All queues under `.knox/queues/` (alphabetical) |
| `directory` | File | `--file ./tasks.yaml` | Single YAML manifest |
| `github` | — | _(no extra flag)_ | Open GitHub Issues with `agent/knox` label |

**Discovery mode** scans `.knox/queues/` for subdirectories containing at least
one `.md` task file. Each qualifying directory becomes a queue. Queues run
sequentially in alphabetical order with a combined summary at the end.

#### Queue options

| Flag        | Default         | Description                                                      |
| ----------- | --------------- | ---------------------------------------------------------------- |
| `--source`  | _(required)_    | Queue source: `directory` or `github`                            |
| `--name`    | —               | Named queue from `.knox/queues/<name>/` (`--source directory`)   |
| `--file`    | —               | Path to a YAML queue manifest (`--source directory`)             |
| `--output`  | config/`branch` | Output strategy: `branch` or `pr`                                |
| `--resume`  | `false`         | Resume from existing state file                                  |
| `--verbose` | `false`         | Show agent output with `[item-id]` prefix                        |
| `--no-tui`  | `false`         | Disable live TUI (use plain log lines)                           |

With `--source directory` and no `--file` or `--name`, Knox auto-discovers
queues under `.knox/queues/`.

#### YAML manifest format

For simple or scripted use cases, queues can also be defined as a single YAML
file:

```yaml
concurrency: 2

defaults:
  model: sonnet
  features:
    - node:22
  prepare: "npm install"
  check: "npm test"
  maxLoops: 5

items:
  - id: lint-rules
    task: "Add stricter ESLint rules for error handling"

  - id: error-types
    task: "Define typed error classes for the API layer"

  - id: refactor-handlers
    task: "Refactor API handlers to use the new error types"
    dependsOn: [error-types]
    group: api-errors

  - id: error-middleware
    task: "Add centralized error-handling middleware"
    dependsOn: [error-types]
    group: api-errors
```

## How It Works

Knox uses a two-phase execution model:

**Phase 1 — Environment (networked).** Knox builds a container image with your
declared features and prepare command. Features install language runtimes
(Python, Node, etc.) into the base image, and the prepare command runs
project-specific setup (e.g., `pip install flask`). The resulting image is
cached — same inputs produce the same cache tag, so subsequent runs skip the
build.

**Phase 2 — Agent (egress-filtered).** Network is restricted to Anthropic API
endpoints and DNS only. Your code is copied in.
Claude Code runs in a loop with `--dangerously-skip-permissions` — the container
boundary is the permission boundary.

Each loop iteration:

1. Knox constructs a prompt with the task, loop number, contents of
   `knox-progress.txt`, and git log from previous loops
2. Claude Code runs and streams output to stdout
3. Knox checks output for `KNOX_COMPLETE` — the agent's signal that the task is
   done
4. If `--check` is provided and the agent signals completion, Knox runs the
   check command. If it fails, the agent gets another loop with the failure
   output injected into the prompt
5. On crash or error, Knox retries up to 3 times with exponential backoff
   (retries don't count against `--max-loops`)

When done, Knox extracts the agent's git commits via git bundle and creates a
`knox/<task-slug>-<runId>` branch on your repo. Your working directory and
current branch are never modified.

In queue mode, each item goes through the same two-phase engine. The
orchestrator schedules items based on the dependency DAG and runs up to
`concurrency` items in parallel. See [How queues run](#how-queues-run).

## Configuration

Knox uses three layers of configuration, each overriding the previous:

1. **Queue definition** (`_defaults.yaml` + task frontmatter, or
   `github.defaults` in config) — what to build. Model, features, prepare
   commands, check commands, dependencies, groups. No output config here.
2. **Project config** (`.knox/config.yaml`) — how to deliver results. Sets the
   output strategy, PR options, and GitHub source settings project-wide.
3. **CLI flags** (`--output`, `--verbose`, etc.) — per-invocation overrides.

```yaml
# .knox/config.yaml
output: pr        # "branch" (default) or "pr"
pr:
  draft: true     # create PRs as drafts
  base: main      # target branch for PRs
github:           # GitHub Issues source config
  authors:        # restrict to issues by these users (defaults to current gh user)
    - alice
    - bob
  defaults:       # queue-level defaults for GitHub Issues (same shape as _defaults.yaml)
    model: sonnet
    features:
      - node:22
    prepare: "npm install"
    maxLoops: 5
```

## Container Environment

Knox containers start with a minimal base image (Ubuntu 24.04 + git + curl).
Claude Code is installed at `/opt/claude/` and is invisible to user processes —
there are no language runtimes on PATH by default. You configure the environment
using **features**, the **prepare** command, or a custom **image**.

### Features

Features are Knox-managed install scripts that add language runtimes to the
container. Each feature supports specific versions validated before any Docker
work begins.

```sh
# See what's available
knox features list
```

| Feature  | Default | Versions                       | Description                        |
| -------- | ------- | ------------------------------ | ---------------------------------- |
| `python` | 3.12    | 3.10, 3.11, 3.12, 3.13        | CPython via deadsnakes PPA         |
| `node`   | 22      | 18, 20, 22                     | Node.js via nvm (separate from Claude Code's Node) |
| `deno`   | 2.0     | 1.46, 2.0, 2.1                | Deno runtime                       |
| `go`     | 1.22    | 1.21, 1.22, 1.23              | Go from official tarball           |
| `rust`   | 1.78    | 1.76, 1.77, 1.78, 1.79, 1.80  | Rust via rustup                    |
| `ruby`   | 3.3     | 3.1, 3.2, 3.3                 | Ruby via ruby-install              |

Use features on the CLI, in `_defaults.yaml`, or in task frontmatter:

```sh
# CLI: comma-separated, with optional version
knox run --task "..." --features "python:3.12,deno"

# Queue defaults (_defaults.yaml)
features:
  - python:3.12
  - deno

# Task frontmatter
---
features:
  - rust:1.78
prepare: "cargo build"
---
```

Bare feature names (e.g., `python`) use the default version. Features install
in alphabetical order for deterministic caching. Multiple features stack into a
single image — `features: [python, deno, rust]` produces a container with all
three runtimes on PATH.

### Prepare command

The `prepare` field runs a shell command with network access after features are
installed. Use it for project-specific setup:

```yaml
features:
  - python:3.12
prepare: "pip install -r requirements.txt"
```

### Custom image

For environments that features don't cover, use `image:` to bring your own
Docker image:

```yaml
image: python:3.12-slim
prepare: "pip install flask"
```

`image` and `features` are mutually exclusive — Knox rejects configs that
specify both. When `image` is used without `prepare`, Knox uses the image
directly. When combined with `prepare`, Knox runs the prepare command and caches
the result.

**Custom image requirements**: Your image must have `git` installed and a
non-root user. Claude Code is invoked via `/opt/claude/bin/claude` which exists
in the Knox base image — custom images should either extend the Knox base image
or install Claude Code at that path.

### Per-item environments

In queues, each item can declare its own environment. Per-item config **replaces**
queue defaults entirely (no merging):

```yaml
# _defaults.yaml — applies to items with no environment config
features:
  - node:22
prepare: "npm install"
```

```markdown
---
features:
  - python:3.12
prepare: "pip install flask"
---

This item gets Python, not Node. Queue defaults are fully replaced.
```

Items with identical environment configs share the same cached image.

### Image caching

Knox caches built images as `knox-cache:<hash>` tags. The cache key is a SHA-256
hash of all inputs: Dockerfile content, feature install script contents, feature
versions, and prepare command. Changing any input produces a new cache key.

```sh
# Remove all cached images
knox cache clear
```

## Architecture

```
features/              # Feature install scripts + metadata
├── python/            #   install.sh + metadata.json per feature
├── node/
├── deno/
├── go/
├── rust/
└── ruby/
src/
├── cli/               # CLI entry point, arg parsing, output formatting
├── engine/            # Core single-run engine
│   ├── agent/         # Agent Runner — loop execution, completion detection, commit recovery
│   ├── session/       # Container Session — container lifecycle, network, bundle extraction
│   ├── source/        # Source Provider — how code gets into a container
│   ├── sink/          # Result Sink — how results get out (branch creation)
│   └── prompt/        # Prompt construction per loop
├── queue/             # Queue orchestration layer
│   ├── tui/           # Queue TUI and Static Renderer
│   └── output/        # Queue Output — post-queue delivery (branches, PRs)
└── shared/            # Shared infra
    ├── features/      # Feature Registry — metadata loading, version resolution
    ├── image/         # Image Manager — build pipeline, caching
    ├── runtime/       # Container Runtime interface + Docker implementation
    ├── auth/          # Credential resolution
    └── knox/          # Network config, project config
```

## Library Usage

Knox is a library first, CLI second:

```typescript
import { Knox } from "./src/mod.ts";

const outcome = await new Knox({
  task: "Add error handling to the API routes",
  dir: "/path/to/project",
  image: "knox-agent:latest",
  envVars: ["ANTHROPIC_API_KEY=..."],
  allowedIPs: ["1.2.3.4"],
  model: "sonnet",
  maxLoops: 5,
  check: "npm test",
  onLine: (line) => console.log(line),
  runtime: new DockerRuntime(),
}).run();

if (outcome.ok) {
  // outcome.result.completed — whether the task finished
  // outcome.result.loopsRun — number of loops executed
  // outcome.result.branchName — git branch with the agent's work
  // outcome.result.commitCount — number of commits made
}
```

The `ContainerRuntime` interface can be swapped for testing or alternative
runtimes:

```typescript
import { type ContainerRuntime, Knox } from "./src/mod.ts";

const knox = new Knox({
  task: "...",
  dir: ".",
  runtime: myCustomRuntime, // implements ContainerRuntime
});
```

## Exit Codes

### `knox run`

| Code  | Meaning                                         |
| ----- | ----------------------------------------------- |
| `0`   | Task completed successfully                     |
| `1`   | Max loops exhausted (partial results extracted)  |
| `2`   | Preflight or validation failure                  |
| `3`   | Crash or fatal error                             |
| `130` | Interrupted (SIGINT)                             |

### `knox queue`

| Code | Meaning                            |
| ---- | ---------------------------------- |
| `0`  | All items completed                |
| `1`  | Some items failed or blocked       |
| `2`  | Validation failure (bad manifest)  |
| `3`  | Orchestrator crash                 |

## License

Knox is licensed under the [Elastic License 2.0](LICENSE). You may use, modify,
and distribute Knox — including in commercial settings — but you may not offer it
as a hosted or managed service to third parties without permission.

## Development

```sh
deno task test          # All tests (requires Docker)
deno task test:unit     # Unit tests only
deno task test:integration  # Docker integration tests
deno task lint          # Lint
deno task fmt           # Format
deno task check         # Type-check
```
