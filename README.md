# Knox

Knox runs Claude Code autonomously inside sandboxed Docker containers. Give it a
task and a directory — it copies your code into a container, runs Claude Code in
an iterative loop until the task is complete, and gives you back the result as a
git branch.

Run a single task, or define a queue of tasks in a YAML manifest with
dependencies and groups — Knox schedules them as a DAG, runs them concurrently,
and produces one branch per group with stacked commits.

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

Knox has two subcommands: `run` (single task) and `queue` (batch from YAML).

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
| `--quiet`          | `false`      | Suppress info messages (warnings and errors only)           |

### Queue — `knox queue`

Define a batch of tasks in a YAML manifest. Knox validates the manifest,
resolves shared resources once, schedules items as a DAG, and runs them with
configurable concurrency.

```sh
# Run a queue
knox queue --file ./tasks.yaml

# Resume a previous run (skips completed items, retries failed)
knox queue --file ./tasks.yaml --resume

# Verbose — show interleaved agent output with [item-id] prefix
knox queue --file ./tasks.yaml --verbose
```

#### Queue manifest format

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

- **`defaults`** — Queue-level defaults merged with per-item overrides.
  Supports `model`, `setup`, `check`, `maxLoops`, `env`, `prompt`, `cpu`,
  `memory`.
- **`concurrency`** — Max items to run in parallel (default: 1).
- **`dependsOn`** — DAG edges. An item runs only after all its dependencies
  complete. Failed items block their transitive dependents; independent items
  continue.
- **`group`** — Items sharing a group produce a single branch
  (`knox/<group>-<runId>`) with stacked commits. Each item in the chain builds
  on its predecessor's output.

#### Queue state and output

- **State file** — Written to `<queue-file>.state.yaml` alongside the manifest.
  Updated on every status transition (`pending` → `in_progress` → `completed` /
  `failed` / `blocked`).
- **Per-item logs** — Agent output captured to `<queue-name>.logs/<item-id>.log`
  regardless of verbosity.
- **Final report** — JSON printed to stdout with all item outcomes.
- **`--resume`** — Reads the existing state file: skips completed items, retries
  failed items, re-evaluates blocked items.

#### Queue options

| Flag        | Default      | Description                              |
| ----------- | ------------ | ---------------------------------------- |
| `--file`    | _(required)_ | Path to the queue YAML manifest          |
| `--resume`  | `false`      | Resume from existing state file          |
| `--verbose` | `false`      | Show agent output with `[item-id]` prefix |

## How It Works

Knox uses a two-phase execution model:

**Phase 1 — Setup (networked).** A container starts with network access. Your
`--setup` command runs (e.g., `npm install`). The resulting state is cached as a
Docker image so subsequent runs skip this step.

**Phase 2 — Agent (air-gapped).** Network is disabled. Your code is copied in.
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

When done, Knox extracts the agent's git commits and applies them to your repo
as a `knox/<task-slug>` branch. Your working directory and current branch are
never modified.

## Architecture

```
src/
├── cli/         # CLI entry point, arg parsing, output formatting
├── engine/      # Core engine: Knox orchestrator, AgentRunner, ContainerSession
│   ├── source/  # SourceProvider — how code gets into a container (GitSourceProvider)
│   ├── sink/    # ResultSink — how results get out (GitBranchSink)
│   ├── agent/   # Agent loop runner
│   ├── session/ # Container lifecycle
│   └── prompt/  # Prompt construction
├── queue/       # Queue orchestrator: manifest loading, DAG scheduling, groups
└── shared/      # Shared infra: auth, Docker runtime, image caching, logging
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
