# Knox

Knox runs Claude Code autonomously inside sandboxed Docker containers. Give it a
task and a directory — it copies your code into a container, runs Claude Code in
an iterative loop until the task is complete, and gives you back the result as a
git branch.

The agent has full access inside the container but zero access to your host
filesystem or network. The container is the permission boundary.

## Install

Requires [Deno](https://deno.land) and [Docker](https://www.docker.com).

```sh
# Run directly
deno run --allow-run --allow-read --allow-write --allow-env --allow-net src/cli.ts --task "..." --dir .

# Or compile to a standalone binary
deno task compile
./knox --task "..." --dir .
```

## Usage

```sh
# Basic usage
knox --task "Add input validation to the signup form" --dir ./my-project

# With setup and verification
knox --task "Fix the flaky pagination test" \
  --dir ./my-project \
  --setup "npm install" \
  --check "npm test" \
  --max-loops 5

# Custom model and resource limits
knox --task "Refactor auth middleware to use JWT" \
  --dir ./my-project \
  --model opus \
  --cpu 4 \
  --memory 8g

# Pass environment variables
knox --task "Update API client" \
  --dir ./my-project \
  --env DATABASE_URL=postgres://localhost/dev \
  --env FEATURE_FLAG=true

# Custom prompt
knox --task "Migrate to TypeScript" \
  --dir ./my-project \
  --prompt ./my-prompt.md
```

## Options

| Flag          | Default      | Description                                                 |
| ------------- | ------------ | ----------------------------------------------------------- |
| `--task`      | _(required)_ | Task description for the agent                              |
| `--dir`       | `.`          | Source directory to work on                                 |
| `--model`     | `sonnet`     | Claude model to use                                         |
| `--setup`     | —            | Setup command run with network access (e.g., `npm install`) |
| `--check`     | —            | Verification command run after agent signals completion     |
| `--max-loops` | `10`         | Maximum agent loop iterations                               |
| `--env`       | —            | Environment variable as `KEY=VALUE` (repeatable)            |
| `--prompt`    | —            | Path to custom prompt file                                  |
| `--cpu`       | —            | CPU limit (e.g., `2`)                                       |
| `--memory`    | —            | Memory limit (e.g., `4g`)                                   |

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

## Library Usage

Knox is a library first, CLI second:

```typescript
import { Knox } from "./src/mod.ts";

const knox = new Knox({
  task: "Add error handling to the API routes",
  dir: "/path/to/project",
  model: "sonnet",
  maxLoops: 5,
  setup: "npm install",
  check: "npm test",
  onLine: (line) => console.log(line),
});

const result = await knox.run();
// result.completed — whether the task finished
// result.loopsRun — number of loops executed
// result.branchName — git branch with the agent's work
// result.commitCount — number of commits made
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

| Code | Meaning                                         |
| ---- | ----------------------------------------------- |
| `0`  | Task completed successfully                     |
| `1`  | Max loops exhausted (partial results extracted) |
| `2`  | Preflight or validation failure                 |
| `3`  | Crash or fatal error                            |

## Development

```sh
deno task test          # All tests (requires Docker)
deno task test:unit     # Unit tests only
deno task test:integration  # Docker integration tests
deno task lint          # Lint
deno task fmt           # Format
deno task check         # Type-check
```
