# Knox

Knox runs Claude Code autonomously inside sandboxed Docker containers. Give it a
task and a directory — it copies your code into a container, runs Claude Code in
an iterative loop until the task is complete, and gives you back the result as a
git branch.

Run a single task, or define a queue of tasks — as a YAML manifest or a
directory of Markdown files — with dependencies and groups. Knox schedules them
as a DAG, runs them concurrently, and produces one branch per group with stacked
commits.

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

Knox has two subcommands: `run` (single task) and `queue` (batch).

### Single task — `knox run`

```sh
# Basic usage
knox run --task "Add input validation to the signup form" --dir ./my-project

# With setup and verification
knox run --task "Fix the flaky pagination test" \
  --dir ./my-project \
  --setup "npm install" \
  --check "npm test" \
  --max-loops 5

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

# Custom prompt
knox run --task "Migrate to TypeScript" \
  --dir ./my-project \
  --prompt ./my-prompt.md
```

#### Run options

| Flag               | Default      | Description                                                 |
| ------------------ | ------------ | ----------------------------------------------------------- |
| `--task`           | _(required)_ | Task description for the agent                              |
| `--dir`            | `.`          | Source directory to work on                                  |
| `--model`          | `sonnet`     | Claude model to use                                         |
| `--setup`          | —            | Setup command run with network access (e.g., `npm install`) |
| `--check`          | —            | Verification command run after agent signals completion     |
| `--max-loops`      | `10`         | Maximum agent loop iterations                               |
| `--env`            | —            | Environment variable as `KEY=VALUE` (repeatable)            |
| `--prompt`         | —            | Path to custom prompt file                                  |
| `--cpu`            | —            | CPU limit (e.g., `2`)                                       |
| `--memory`         | —            | Memory limit (e.g., `4g`)                                   |
| `--skip-preflight` | `false`      | Skip preflight checks                                       |
| `--verbose`        | `false`      | Show debug-level messages                                   |
| `--output`         | config/`branch` | Output strategy: `branch` or `pr`                      |
| `--quiet`          | `false`      | Suppress info messages (warnings and errors only)           |

### Queue — `knox queue`

Knox queues are a three-stage pipeline: **Ingest** (load task definitions) →
**Build** (run each task in a container) → **Output** (deliver results as
branches or PRs).

```sh
# Run a named queue from .knox/queues/<name>/
knox queue --name auth-refactor

# Auto-discover and run all queues under .knox/queues/
knox queue

# Run a YAML queue file
knox queue --file ./tasks.yaml

# Resume a previous run (skips completed items, retries failed)
knox queue --name auth-refactor --resume

# Output as PRs instead of branches
knox queue --output pr

# Verbose with live TUI disabled (plain log lines)
knox queue --verbose --no-tui
```

#### Defining a queue

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

Frontmatter fields: `dependsOn`, `model`, `setup`, `check`, `group`,
`maxLoops`, `env`, `cpu`, `memory`. Files prefixed with `_` are skipped
(reserved for config).

An optional `_defaults.yaml` provides queue-level defaults — same shape as the
YAML manifest `defaults` key:

```yaml
# _defaults.yaml
model: sonnet
setup: "npm install"
check: "npm test"
maxLoops: 5
```

Alternatively, a queue can be a single YAML manifest file (see
[YAML format](#yaml-manifest-format) below).

#### How queues run

1. **Ingest** — Knox loads task definitions via a Queue Source (Markdown
   directory or YAML file), parses and validates the manifest, and builds the
   dependency DAG.

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

- **State file** — `.state.yaml` written alongside the manifest (YAML mode) or
  inside the queue directory (Markdown mode). Updated on every status transition
  (`pending` → `in_progress` → `completed` / `failed` / `blocked`).
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

| Mode | Flag | Source |
| ---- | ---- | ------ |
| Named | `--name my-queue` | Markdown directory at `.knox/queues/my-queue/` |
| Discovery | _(no flag)_ | All queues under `.knox/queues/` (alphabetical) |
| File | `--file ./tasks.yaml` | Single YAML manifest |

**Discovery mode** scans `.knox/queues/` for subdirectories containing at least
one `.md` task file. Each qualifying directory becomes a queue. Queues run
sequentially in alphabetical order with a combined summary at the end.

#### Queue options

| Flag        | Default         | Description                               |
| ----------- | --------------- | ----------------------------------------- |
| `--name`    | —               | Named queue from `.knox/queues/<name>/`   |
| `--file`    | —               | Path to a YAML queue manifest             |
| `--output`  | config/`branch` | Output strategy: `branch` or `pr`         |
| `--resume`  | `false`         | Resume from existing state file           |
| `--verbose` | `false`         | Show agent output with `[item-id]` prefix |
| `--no-tui`  | `false`         | Disable live TUI (use plain log lines)    |

With no `--file` or `--name`, Knox auto-discovers queues under `.knox/queues/`.

#### YAML manifest format

For simple or scripted use cases, queues can also be defined as a single YAML
file:

```yaml
concurrency: 2

defaults:
  model: sonnet
  setup: "npm install"
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

**Phase 1 — Setup (networked).** A container starts with network access. Your
`--setup` command runs (e.g., `npm install`). The resulting state is cached as a
Docker image so subsequent runs skip this step.

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

1. **Queue definition** (`_defaults.yaml` + task frontmatter) — what to build.
   Model, setup commands, check commands, dependencies, groups. No output
   config here.
2. **Project config** (`.knox/config.yaml`) — how to deliver results. Sets the
   output strategy and PR options project-wide.
3. **CLI flags** (`--output`, `--verbose`, etc.) — per-invocation overrides.

```yaml
# .knox/config.yaml
output: pr        # "branch" (default) or "pr"
pr:
  draft: true     # create PRs as drafts
  base: main      # target branch for PRs
```

## Architecture

```
src/
├── cli/           # CLI entry point, arg parsing, output formatting
├── engine/        # Core single-run engine
│   ├── agent/     # Agent Runner — loop execution, completion detection, commit recovery
│   ├── session/   # Container Session — container lifecycle, network, bundle extraction
│   ├── source/    # Source Provider — how code gets into a container
│   ├── sink/      # Result Sink — how results get out (branch creation)
│   └── prompt/    # Prompt construction per loop
├── queue/         # Queue orchestration layer
│   ├── tui/       # Queue TUI and Static Renderer
│   └── output/    # Queue Output — post-queue delivery (branches, PRs)
└── shared/        # Shared infra: auth, Docker runtime, image caching, logging
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

## Development

```sh
deno task test          # All tests (requires Docker)
deno task test:unit     # Unit tests only
deno task test:integration  # Docker integration tests
deno task lint          # Lint
deno task fmt           # Format
deno task check         # Type-check
```
