# Knox — AI Agent Sandbox

## Problem Statement

Running AI coding agents (like Claude Code) directly on a developer's machine is
risky. The agent has full access to the filesystem, network, and system
resources. A mistake — or a hallucination — can delete files, exfiltrate data,
or corrupt a working repository. Developers want to give AI agents ambitious,
long-running tasks and walk away, but they can't trust an unsandboxed agent with
that level of autonomy.

There is no simple, general-purpose tool that lets a developer say "here's a
task, here's my code, go work on it safely in a box, and give me back the result
when you're done."

## Solution

Knox is a Deno (TypeScript) library and CLI that runs Claude Code autonomously
inside sandboxed containers. The developer provides a task description, a local
directory, and optional configuration. Knox copies the code into a container,
runs Claude Code in an iterative loop until the task is complete (or max loops
are exhausted), and extracts the agent's work as a git branch on the host.

The key properties of Knox are:

- **Isolation**: The agent runs in a container with no network access during
  execution. The host filesystem is never directly mutated. The container is the
  permission boundary — Claude Code runs with full unrestricted access inside
  it.
- **Autonomy**: Once started, Knox requires no human intervention. The agent
  works in a loop, committing progress and signaling completion via a magic
  string (`KNOX_COMPLETE`).
- **Safety**: A two-phase execution model — a networked setup phase installs
  dependencies, then network is cut before the agent starts. Results are
  extracted as git commits, not raw file overwrites.
- **Composability**: Knox is a library first, CLI second. Other tools can import
  and embed Knox's sandbox capabilities.

## User Stories

1. As a developer, I want to give an AI agent a coding task and walk away, so
   that I can focus on other work while the agent operates autonomously.
2. As a developer, I want the agent to run in a sandboxed container, so that it
   cannot access my host filesystem, network, or system resources during
   execution.
3. As a developer, I want to specify a task via a CLI flag (`--task`), so that I
   can quickly kick off work without writing config files.
4. As a developer, I want to point Knox at a local directory (`--dir`), so that
   the agent works on my existing codebase.
5. As a developer, I want Knox to copy my code into the container rather than
   bind-mounting it, so that the agent cannot mutate my working directory during
   execution.
6. As a developer, I want the agent's changes returned as a git branch
   (`knox/*`), so that I can review, cherry-pick, or merge the results using
   standard git workflows.
7. As a developer, I want to set a maximum number of loops (`--max-loops`), so
   that I can control cost and prevent runaway execution.
8. As a developer, I want the default max loops to be 10, so that I have a
   sensible starting point without needing to think about it.
9. As a developer, I want the agent to signal completion by outputting
   `KNOX_COMPLETE`, so that Knox can stop early when the task is genuinely
   finished.
10. As a developer, I want Knox to extract partial results when max loops are
    exhausted, so that I don't lose the agent's progress even if the task isn't
    fully complete.
11. As a developer, I want the agent to maintain a `knox-progress.txt` file
    across loops, so that each loop has context about what previous loops
    accomplished, what failed, and what to do next.
12. As a developer, I want to specify a verification command
    (`--check "npm test"`), so that Knox can programmatically verify the agent's
    work rather than relying solely on self-assessment.
13. As a developer, I want Knox to re-run the agent with failure context when
    the verification check fails after the agent signals completion, so that
    false completion claims are caught and corrected.
14. As a developer, I want to specify setup commands (`--setup "npm install"`),
    so that dependencies are installed before the agent starts working.
15. As a developer, I want the setup phase to have network access, so that
    package managers can download dependencies.
16. As a developer, I want network to be disabled after the setup phase, so that
    the agent cannot exfiltrate data or make unexpected external calls during
    execution.
17. As a developer, I want Knox to cache the post-setup container state, so that
    subsequent runs on the same project skip the dependency installation step.
18. As a developer, I want to pass environment variables via CLI flags
    (`--env KEY=VALUE`), so that I can provide API keys and tokens to the
    container.
19. As a developer, I want Knox to stream the agent's output to stdout in
    real-time, so that I can monitor progress if I choose to watch.
20. As a developer, I want Knox to perform preflight checks (container runtime
    available, API key set, source directory exists), so that I get clear error
    messages instead of cryptic failures.
21. As a developer, I want Knox to retry up to 3 times with backoff when the
    agent crashes or the Claude CLI errors, so that transient failures (rate
    limits, network blips during setup) don't waste an entire run.
22. As a developer, I want Claude Code to run with
    `--dangerously-skip-permissions` inside the container, so that the agent
    never stalls waiting for permission input. The container boundary is the
    permission boundary.
23. As a developer, I want to specify which Claude model to use (`--model`), so
    that I can trade off between cost, speed, and capability per task.
24. As a developer, I want Knox to inject a git log of previous loop commits
    into each new loop's prompt, so that the agent has context on what work has
    already been done.
25. As a developer, I want Knox to use a sensible built-in prompt by default, so
    that I don't need to write prompt engineering to get started.
26. As a developer, I want to override the default prompt with my own
    (`--prompt ./my-prompt.md`), so that I can customize agent behavior for
    specific workflows.
27. As a developer, I want Knox to enforce sensible default resource limits
    (CPU, memory) on the container, so that a runaway agent doesn't starve my
    machine.
28. As a developer, I want to override resource limits via CLI flags, so that I
    can allocate more resources for heavy tasks.
29. As a developer, I want Knox to build and cache its agent Docker image
    automatically on first run, so that I don't need to manage Dockerfiles or
    images manually.
30. As a library consumer, I want to import Knox's core modules and use them
    programmatically, so that I can embed sandboxed agent execution in my own
    tools and workflows.
31. As a developer, I want Knox to exit with a non-zero exit code when the task
    fails or max loops are exhausted without completion, so that I can use Knox
    in scripts and CI pipelines.
32. As a developer, I want the container runtime to be abstracted behind an
    interface, so that alternative runtimes (e.g., Apple container) can be
    supported in the future without refactoring.

## Implementation Decisions

### Language and Runtime

- Knox is written in TypeScript and runs on Deno.
- The project is structured as a library with a thin CLI wrapper, so the core
  logic can be imported by other tools.

### Container Runtime Abstraction

- A `ContainerRuntime` interface defines the operations Knox needs:
  `buildImage`, `createContainer`, `exec`, `copyIn`, `copyOut`, `streamLogs`,
  `stop`, `remove`, `setNetworkEnabled`.
- The MVP ships with a `DockerRuntime` implementation only.
- The interface is designed so that an `AppleContainerRuntime` (for Apple's
  Virtualization.framework-based container tool) can be added later with zero
  changes to consuming code.

### Image Management (`ImageManager`)

- Knox ships a built-in Dockerfile that installs Claude Code, git, and essential
  tools on a base image.
- On first run, Knox builds and caches this image automatically.
- The setup phase runs user-specified commands (`--setup`) with network access,
  then commits the resulting container state as a cached image layer.
- Cache invalidation occurs when the setup command changes.

### Two-Phase Execution

- **Phase 1 — Setup (networked):** Container starts with network access. Knox
  runs the user's `--setup` commands (e.g., `npm install`). The resulting state
  is cached.
- **Phase 2 — Agent (air-gapped):** Network is disabled. Knox invokes Claude
  Code in a loop. The agent has full filesystem and process access inside the
  container but cannot reach the network.

### Loop Execution (`LoopExecutor`)

- Each loop is one `claude -p` (print/non-interactive mode) CLI invocation with
  `--dangerously-skip-permissions` and `--model <model>`.
- Before each loop, Knox constructs a prompt that includes: the task
  description, the current loop number, the contents of `knox-progress.txt`, and
  a git log of commits from previous loops.
- Output is processed line-by-line: each line is printed to stdout (streaming)
  and checked for the `KNOX_COMPLETE` sentinel.
- If `KNOX_COMPLETE` is found and `--check` is provided: run the check command.
  If check passes, stop looping and extract results. If check fails, revoke
  completion and re-run the next loop with the check failure output injected
  into the prompt.
- If `KNOX_COMPLETE` is found and no `--check` is provided: stop looping,
  extract results.
- If max loops reached: stop looping, extract partial results, exit with
  non-zero code.
- **Retry semantics:** On error (claude CLI crashes, API rate limit, non-zero
  exit), retry up to 3 times with exponential backoff. Retries do NOT consume
  loop iterations — only successful completions count against max-loops. After 3
  consecutive failures on the same loop, abort and extract partial results.

### Prompt Construction (`PromptBuilder`)

- Knox has a built-in default prompt that prescribes a structured workflow for
  the agent. The default prompt is intentionally unopinionated about testing —
  that's left to the user's task description.
- The user can override the prompt entirely with `--prompt <path>`.
- Each loop's prompt is augmented with: contents of `knox-progress.txt`, git log
  of previous loop commits, and (if applicable) check failure output from the
  previous loop.

### Default Prompt Workflow

The built-in prompt instructs the agent to follow these phases in order:

1. **READ** — Read `knox-progress.txt` to understand what previous loops
   accomplished, what failed, and what to do next.
2. **EXPLORE** — Explore the codebase to understand the current state and fill
   context with relevant information.
3. **PLAN** — Plan the approach for this loop iteration. Focus on making
   meaningful, incremental progress.
4. **EXECUTE** — Implement the planned work.
5. **COMMIT** — Make a git commit using conventional commit format (e.g.,
   `feat:`, `fix:`, `refactor:`). The commit message should include what was
   done and key decisions made.
6. **UPDATE** — Append a structured update to `knox-progress.txt` with: what was
   accomplished, key decisions, blockers encountered, and notes for the next
   loop iteration.
7. **SIGNAL** — If the task is fully and genuinely complete, output
   `KNOX_COMPLETE`. Only signal completion if the work is truly done — do not
   signal completion to escape the loop.

### Progress File (`knox-progress.txt`)

- A file inside the container that persists across loops within a single run.
- Each loop appends a structured entry with: loop number, what was done, what
  failed, blockers, and notes for the next iteration.
- This file serves as cross-loop memory since each `claude` invocation starts
  with a fresh context window.
- The progress file is included in the extracted results so the user can review
  the agent's reasoning.

### Result Extraction (`ResultExtractor`)

- On completion, Knox extracts the git commits the agent made inside the
  container.
- These commits are applied to the host repository as a new branch named
  `knox/<task-slug>`.
- The host's working directory and current branch are never modified.
- If the source directory is not a git repo, Knox falls back to copying files to
  an output directory.

### Preflight Checks (`PreflightChecker`)

- Before starting, Knox validates: container runtime is available and
  responsive, required environment variables (API key) are set, source directory
  exists, source directory is a git repository (warning if not).
- Fails fast with actionable error messages.

### CLI Interface

- All configuration is via CLI flags for the MVP. No config files.
- Flags: `--task`, `--dir`, `--max-loops` (default: 10), `--model`, `--setup`,
  `--env` (repeatable), `--prompt`, `--check` (optional verification command).
- Network is disabled by default during the agent phase. Network is only enabled
  during the setup phase.

### Resource Limits

- Knox applies sensible default CPU and memory limits to the container.
- Users can override with CLI flags.

## Testing Decisions

### Testing Philosophy

- Tests should verify external behavior through module interfaces, not
  implementation details.
- Tests should be deterministic and not depend on external services (Docker,
  Claude API) unless explicitly marked as integration tests.
- Use dependency injection (the `ContainerRuntime` interface) to make modules
  testable with mock/stub implementations.

### Modules Under Test

1. **ContainerRuntime / DockerRuntime** — Integration tests that verify Docker
   operations work end-to-end (build, create, exec, copy-in/out, network
   toggling). These require Docker to be running and are slower. Unit tests for
   argument construction and output parsing.

2. **ImageManager** — Tests for image build logic, cache key computation, cache
   hit/miss behavior, and setup command execution. Use a mock `ContainerRuntime`
   to avoid real Docker calls in unit tests.

3. **LoopExecutor** — Tests for the core loop: completion detection
   (KNOX_COMPLETE parsing), max-loop enforcement, retry logic with backoff,
   error handling, git log injection between loops. This is the highest-risk
   module. Use a mock runtime and mock claude invocations.

4. **PromptBuilder** — Tests for prompt construction: default prompt content,
   user override merging, git log injection, loop number injection, task
   interpolation.

5. **ResultExtractor** — Tests for git commit extraction, branch creation on
   host, handling of non-git directories, edge cases (no commits made, merge
   conflicts on branch name).

6. **PreflightChecker** — Tests for each validation check: missing runtime,
   missing API key, missing directory, non-git directory. Verify error messages
   are actionable.

7. **CLI** — Tests for flag parsing, defaults, validation of required flags, and
   correct delegation to library modules.

## Out of Scope

- **Config files** (e.g., `knox.json`) — MVP uses CLI flags only. Config file
  support may be added later.
- **Apple container runtime** — The interface is designed for it, but only
  Docker is implemented in MVP.
- **Parallel task execution** — One task at a time for MVP.
- **Resume/restart of interrupted runs** — If a run is interrupted, the user
  starts over. Partial git commits are still extractable.
- **Notifications** (desktop, webhook, etc.) — User can wrap Knox in their own
  notification tooling.
- **Git URL cloning** — MVP only supports local directories. Git URL support may
  be added later.
- **Custom Dockerfiles** — Knox owns the agent image. Custom Dockerfile support
  may be added later.
- **Non-Claude-Code agents** — Knox is purpose-built for Claude Code. Supporting
  other agents is not planned for MVP.

## Further Notes

- The name "knox" evokes Fort Knox — a secure, contained environment.
- The `KNOX_COMPLETE` sentinel is checked line-by-line in agent output. The
  default prompt includes an honesty guard instructing the agent not to falsely
  signal completion. When `--check` is provided, programmatic verification acts
  as a second layer of defense against false completion signals.
- The cached setup image strategy means first runs are slow but subsequent runs
  are fast. This trade-off favors iterative development workflows.
- Deno's built-in `deno compile` provides a path to standalone binary
  distribution without additional tooling.
- The `ContainerRuntime` interface should be minimal and stable — resist adding
  convenience methods that could differ across runtime implementations.
- The `DockerRuntime` implementation shells out to the `docker` CLI via
  `Deno.Command` rather than using a Docker SDK (none exists for Deno). This is
  intentional — it keeps the implementation portable and consistent with how an
  `AppleContainerRuntime` would also work (via the `container` CLI).
- The two-phase execution (setup vs. agent) requires two separate containers:
  one networked container for setup (whose state is committed as a cached
  image), and a second air-gapped container (`--network none`) for agent
  execution. Docker does not support toggling network on a running container.
- The `knox-progress.txt` pattern is borrowed from the RALPH/Sandcastle
  ecosystem, where persistent cross-loop context files are the standard
  mechanism for maintaining agent memory across fresh context windows.
