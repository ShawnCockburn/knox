# Ubiquitous Language

## Sandbox & Execution

| Term                  | Definition                                                                                             | Aliases to avoid                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **Container**         | An isolated Docker environment where the Agent executes a Task                                         | Sandbox, VM, box                                                  |
| **Container Runtime** | Abstract interface for container operations (build, exec, copy, restrict network)                      | Docker (when referring to the abstraction)                        |
| **Workspace**         | The `/workspace` directory inside the Container where source code lives and the Agent works            | Workdir, working directory                                        |
| **Base Image**        | The Knox-built Docker image (`knox-agent:latest`) containing Ubuntu 24.04, git, curl, and Claude Code isolated at `/opt/claude/` — no user-facing runtimes | Image (ambiguous — see flagged ambiguities)                       |
| **Cached Image** (updated) | A Docker image tagged `knox-cache:<hash>` produced by running Features and/or a Prepare Command on the Base Image or Custom Image; the cache key is a SHA-256 hash of all inputs | Setup Image, cache image                                         |

## Container Environment (new)

| Term | Definition | Aliases to avoid |
| ---- | ---------- | ---------------- |
| **Feature** (new) | A Knox-maintained install script that adds a language runtime (e.g., Python, Node, Rust) to the Base Image; declared by name with an optional version | Runtime, language, tool |
| **Feature Registry** (new) | The module that discovers, loads, and validates Feature metadata from the in-repo `features/` directory; the single source of truth for what Features exist and which versions they support | Feature loader, feature manager |
| **Feature Metadata** (new) | The `metadata.json` file inside a Feature directory containing `name`, `description`, `defaultVersion`, `supportedVersions`, and `provides` (list of binaries added to PATH) | Feature config, feature definition |
| **Feature Install Script** (new) | The `install.sh` file inside a Feature directory; receives version as first argument, runs as root, must be idempotent, exits non-zero on failure | Install script, setup script |
| **Resolved Feature** (new) | A Feature after validation and version resolution: contains name, version, install script path, and install script content; ready for image building | Parsed feature, validated feature |
| **Custom Image** (new) | A user-provided Docker image specified via the `image:` field; mutually exclusive with Features | External image, user image |
| **Environment Config** (new) | The combination of `features`, `prepare`, and `image` fields that define a Container's environment; exists at both Queue Defaults and per-item level | Env config, runtime config |
| **Image Resolver** (new) | A function used by the Orchestrator to resolve per-item Environment Config to a Docker image ID via the Image Manager | Image builder, image factory |

## Agent & Task

| Term                  | Definition                                                                                       | Aliases to avoid                             |
| --------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| **Agent**             | The Claude Code instance running autonomously inside the Container                               | Bot, worker, runner                          |
| **Task**              | A user-provided description of work for the Agent to complete                                    | Job, prompt (when meaning the user's intent) |
| **Task Slug**         | A URL-safe transformation of the Task description, used for branch names                         | Task ID, task key                            |
| **Loop**              | A single invocation of Claude Code inside the Container; the Agent may run across multiple Loops | Iteration, cycle, round                      |
| **Max Loops**         | The upper bound on Loop count before Knox stops and extracts partial results (default: 10)       | Max iterations, loop limit                   |
| **Completion Signal** | The sentinel string `KNOX_COMPLETE` output by the Agent to indicate the Task is finished         | Done marker, exit signal                     |
| **Progress File**     | The persistent file `knox-progress.txt` inside the Container that carries context across Loops   | State file, log file, memory file            |

## Run Identity

| Term              | Definition                                                                                                                                      | Aliases to avoid      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **Run ID**        | An 8-hex-character identifier generated at the start of each Knox engine run, used to correlate Container, branch, temp directory, and result metadata | Job ID, session ID    |
| **Run Directory** | The temporary directory `/tmp/knox-<Run ID>/` that holds all artifacts for a single run                                                         | Temp dir, working dir |

## Source & Sink

| Term                | Definition                                                                                                                      | Aliases to avoid                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Source Provider**  | Container-agnostic interface that prepares source material on the host for injection into a Container                           | Input strategy, source strategy             |
| **Source Metadata**  | A discriminated union describing how source was prepared, keyed on Source Strategy (e.g., base commit, repo path)               | Source info, source context                 |
| **Source Strategy**  | An enum member identifying which Source Provider produced the Source Metadata (MVP: `HostGit`)                                  | Source type                                 |
| **Result Sink**      | Container-agnostic interface that receives a Git Bundle and produces a Sink Result                                              | Output strategy, result strategy, extractor |
| **Sink Result**      | A discriminated union describing the outcome of a Result Sink, keyed on Sink Strategy (e.g., branch name for HostGit)           | Extract result, output result               |
| **Sink Strategy**    | An enum member identifying which Result Sink produced the Sink Result (MVP: `HostGit`; future: `RemoteGit`, `Filesystem`, `PR`) | Sink type, output type                      |

## Transfer Mechanism

| Term                    | Definition                                                                                                                                    | Aliases to avoid                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Git Bundle**          | A portable file containing git objects, created inside the Container and fetched on the host to create a Result Branch                        | Patch file, format-patch, archive                                                  |
| **Base Commit**         | The host repo's HEAD SHA at the time Source Provider snapshots the code; the anchor point for the Result Branch                               | Initial commit (overloaded — was previously used for the container's first commit) |
| **Shallow Clone**       | A `git clone --depth 1` of the host repo used to prepare source; ensures the Agent sees only committed state at HEAD with no history          | Snapshot, archive, export                                                          |
| **Result Branch**       | A git branch on the host repo containing the Agent's commits, created without switching the host's checkout; named `knox/<Task Slug>-<Run ID>` for single runs, or **Group Branch** for grouped Queue Items | Output branch                                                                      |

## Commit Recovery

| Term              | Definition                                                                                                                                                            | Aliases to avoid               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Commit Nudge**  | A lightweight, single-purpose Claude invocation that instructs the Agent to review its diff and commit with a meaningful message, without making further code changes | Commit reminder, commit retry  |
| **Auto-Commit**   | A mechanical `git add -A && git commit` performed by Knox as a last resort when the Agent fails to commit after a Commit Nudge                                        | Fallback commit, safety commit |

## Two-Phase Execution

| Term                 | Definition                                                                                                         | Aliases to avoid                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| **Prepare Command** (updated) | An optional user-provided command (e.g., `pip install -r requirements.txt`) run with network access after Features are installed but before the Agent phase; replaces the former `setup` field | Setup command, install command, init command                 |
| **Egress Filtering** | Network restriction allowing only HTTPS to Anthropic API endpoints and DNS; applied via iptables                   | Air-gapped (inaccurate — DNS and API are allowed), firewall |
| **Allowed IPs**      | The set of resolved IP addresses for Anthropic API endpoints that Egress Filtering permits                         | Whitelist                                                   |

## Authentication

| Term                      | Definition                                                                                        | Aliases to avoid            |
| ------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------- |
| **Credential**            | An OAuth token or API key used to authenticate the Agent with the Claude API                      | Auth, secret, token (alone) |
| **Credential Provider**   | Platform-specific implementation that retrieves Credentials (Keychain on macOS, file on Linux)    | Auth provider               |
| **Credential Resolution** | The process of finding a valid Credential: check env var first, then platform Credential Provider | Auth flow, login            |

## Verification

| Term              | Definition                                                                                    | Aliases to avoid                      |
| ----------------- | --------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Check Command** | An optional user-provided command (e.g., `npm test`) run after the Agent signals completion   | Verification command, test command    |
| **Check Failure** | When the Check Command exits non-zero, indicating the Agent's Completion Signal was premature | False completion, failed verification |

## Single-Run Orchestration

| Term                    | Definition                                                                                                                    | Aliases to avoid                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Knox**                | The single-run engine that coordinates a Container Session, Agent Runner, bundle extraction, and result sinking for one Task | Runner, executor (when meaning the whole system) |
| **Knox Outcome**        | A discriminated union result from a Knox engine run: `{ ok: true, result }` or `{ ok: false, error, phase }`                 | Result (ambiguous with KnoxResult)               |
| **Preflight Check**     | A validation run before execution: Docker available, Credentials present, source directory exists, dirty working tree warning | Pre-check, startup validation                    |
| **Container Session**   | A deep module that owns the entire lifecycle of a sandboxed Container: creation, workspace setup, command execution, result extraction, and cleanup | Session, sandbox context                         |
| **Agent Runner**        | A deep module that owns Agent execution as a coherent operation: running Loops, detecting the Completion Signal, verifying Check Commands, and performing Commit Nudge with Auto-Commit fallback | Loop executor, agent loop                        |
| **Image Manager**       | The module that builds the Base Image, installs Features, runs Prepare Commands, and caches the resulting images             | Builder, image builder                           |

## Queue Orchestration

| Term | Definition | Aliases to avoid |
| ---- | ---------- | ---------------- |
| **Queue** | A YAML manifest or directory of Markdown files describing multiple Tasks to be executed, with optional dependencies, groups, concurrency, and defaults | Batch, job list, task list |
| **Queue Item** | A single entry in a Queue, consisting of an `id`, a `task` description, and optional overrides for model, features, prepare, image, check, env, etc. | Task (when referring to the queue entry rather than the work description), job |
| **Queue Defaults** | Queue-level configuration values (model, maxLoops, features, prepare, env, etc.) that merge with per-item overrides; item values take precedence | Global config, base config |
| **Queue State** | A persistent record of a Queue Run's progress, stored in a `.state.yaml` file alongside the Queue file or inside the queue directory | State file (ambiguous with Progress File), checkpoint |
| **Item Status** | The lifecycle state of a Queue Item: `pending`, `in_progress`, `completed`, `failed`, or `blocked` | Status, state (too generic) |
| **Queue Run ID** | An 8-hex-character identifier for an entire Queue execution, distinct from per-item Run IDs | Run ID (ambiguous — see flagged ambiguities) |
| **Orchestrator** | The component that loads a Queue, schedules Queue Items via the DAG Scheduler, invokes Knox for each item, tracks Queue State, and produces a Queue Report | Queue runner, batch runner, scheduler (the scheduler is a part of the Orchestrator, not the whole) |
| **DAG** | The directed acyclic graph of dependencies formed by `dependsOn` declarations between Queue Items | Dependency tree (inaccurate — it's a graph, not a tree), dep graph |
| **Ready Item** | A Queue Item whose status is `pending` and whose dependencies have all reached `completed` status | Runnable item, eligible item |
| **Blocked** | An Item Status meaning the item cannot run because a direct or transitive dependency has `failed` | Skipped (inaccurate — skipped implies intentional), cancelled |
| **Group** | A named set of Queue Items that form a linear chain producing a single branch with stacked commits | Chain, pipeline, sequence |
| **Group Branch** | The shared Result Branch for all items in a Group, named `knox/<group>-<Queue Run ID>` | Shared branch, chain branch |
| **Chained Execution** | The mechanism where each subsequent item in a Group clones from the Group Branch (its predecessor's output) via Source Provider `ref` parameter | Stacking, sequential build |
| **Concurrency** | The maximum number of Queue Items that may run simultaneously, configured at the Queue level (default: 1) | Parallelism, workers, pool size |
| **Resume** | Re-running an Orchestrator from an existing Queue State: `completed` items are skipped, `failed` and `blocked` items are reset to `pending` | Retry (ambiguous with transient error retry), restart |
| **Queue Report** | The final JSON output of an Orchestrator run, printed to stdout, containing all item statuses, branches, durations, and outcomes | Summary (ambiguous with stderr summary), results |
| **Item Log** | A per-item text file capturing all Agent output, written to `<queue-name>.logs/<item-id>.log` regardless of verbosity | Log file (too generic) |
| **Validation Error** | A structural, referential, cycle, or group-linearity error detected at Queue load time; all errors are collected before reporting | Parse error (too narrow) |

## Queue Ingest

| Term | Definition | Aliases to avoid |
| ---- | ---------- | ---------------- |
| **Queue Source** | Interface for loading a Queue and persisting Queue State; the data layer for the Orchestrator — has two implementations: **File Queue Source** and **Directory Queue Source** | Queue loader, queue provider |
| **File Queue Source** | YAML-file-backed implementation of Queue Source; reads from `<name>.yaml`, writes state to `<name>.state.yaml` | YAML loader |
| **Directory Queue Source** | Markdown-directory-backed implementation of Queue Source; reads `.md` files from a directory, optional `_defaults.yaml` for Queue Defaults, state to `.state.yaml` inside the directory | Markdown queue source, directory loader |
| **Markdown Task Parser** | Pure function that parses a single Markdown task file into a Queue Item or validation errors | Task parser, markdown parser |
| **Frontmatter** | YAML section at the start of a Markdown task file (between `---` delimiters) containing optional Queue Item overrides: `dependsOn`, `model`, `features`, `prepare`, `image`, `check`, `group`, `maxLoops`, `env`, `cpu`, `memory` | YAML header, metadata |
| **Task Body** | The Markdown content after Frontmatter; becomes the Queue Item's task description | Task content, body text |

## Queue Output

| Term | Definition | Aliases to avoid |
| ---- | ---------- | ---------------- |
| **Queue Output** | Interface called after all Queue Items complete to deliver results; method `onQueueComplete(report)` | Output handler, post-queue handler |
| **Branch Queue Output** | No-op Queue Output implementation; Result Branches already exist from per-item Result Sinks, so no additional delivery is needed | Default output, branch mode |
| **Pull Request Queue Output** | Queue Output implementation that creates a GitHub PR (via `gh` CLI) for each completed Queue Item's branch | PR output, GitHub output |

## Queue Discovery & Multi-Queue

| Term | Definition | Aliases to avoid |
| ---- | ---------- | ---------------- |
| **Queue Discovery** | Scanning `.knox/queues/` for subdirectories containing at least one `.md` task file (excluding `_`-prefixed files); returns sorted alphabetically | Queue scanning, queue detection |
| **Discovered Queue** | A queue directory found under `.knox/queues/` with a `name` (directory name) and `path` (absolute path) | Found queue, queue reference |
| **Multi-Queue Runner** | Component that runs multiple Discovered Queues sequentially, each with its own Orchestrator, renderer, and Queue Output callback | Batch runner, queue runner (ambiguous with Orchestrator) |
| **Multi-Queue Report** | Aggregated result containing an array of `{ name, report }` entries — one per queue executed | Combined report, summary |

## Project Configuration

| Term | Definition | Aliases to avoid |
| ---- | ---------- | ---------------- |
| **Knox Config** | Project-level configuration loaded from `.knox/config.yaml`; defines `output` strategy and `pr` options | Project config, config file (too generic) |
| **Output Strategy** | Enum value `"branch"` or `"pr"` determining how Knox results are delivered; configurable via `.knox/config.yaml` or `--output` CLI flag (flag takes precedence) | Output type, delivery mode |

## Queue TUI

| Term | Definition | Aliases to avoid |
| ---- | ---------- | ---------------- |
| **Queue TUI** | The live-updating ANSI table rendered to stderr showing real-time Queue progress with spinner, colors, and status counts | Dashboard, UI, display |
| **Static Renderer** | The non-interactive fallback that prints timestamped `[HH:MM:SS] [item-id] <description>` log lines to stderr, used in non-TTY or `--no-tui` mode | Static fallback, plain renderer, plain mode |
| **Display State** | The TUI's per-item view model, derived from Knox Events via a pure reducer function (`applyEvent`) | View state, render state |
| **Display Status** | The TUI's status enum: `pending`, `running`, `completed`, `failed`, `blocked`, `aborted` — a superset of Item Status that adds `aborted` as a first-class visual state and renames `in_progress` to `running` | Render status |
| **Phase** | A human-readable label describing the current activity of a running item (e.g., "setting up", "loop 2/5", "check failed, retrying", "extracting results") | Step, stage, activity |
| **Spinner** | The animated braille indicator (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) cycling at 80ms for running items in the Queue TUI | Loading indicator, progress indicator |
| **Log Panel** | The scrolling area below the status table showing live Agent output lines in `--verbose` TUI mode, with color-coded item ID prefixes | Output panel, console, verbose panel |
| **Freeze** | The act of stopping TUI redraws so the final frame persists in terminal scrollback; occurs on normal completion or Ctrl+C | Lock, stop rendering, persist |

## Relationships

- A **Knox** engine run generates exactly one **Run ID** and one **Run
  Directory**
- A **Knox** engine run creates exactly one **Container Session**, which owns one
  **Container** named `knox-<Run ID>`
- A **Source Provider** prepares source material into the **Run Directory**,
  producing **Source Metadata** with a **Base Commit**
- Source is injected into the **Container** via **Shallow Clone** — committed
  state only, no history
- A **Container Session** hides all container plumbing: creation, source copy,
  ownership, network restriction, git verification, exclude setup, bundle
  extraction, and cleanup
- An **Agent Runner** takes a **Container Session** and produces an
  **AgentRunResult** (completed, loopsRun, autoCommitted)
- An **Agent Runner** never touches container plumbing — it only calls
  `exec()`, `execStream()`, and `hasDirtyTree()` on the **Container Session**
- A **Task** produces one or more **Loops**, up to **Max Loops**
- Each **Loop** is a fresh Claude Code invocation; the **Progress File** carries
  context between them
- A **Loop** may emit a **Completion Signal**, which triggers the **Check
  Command** (if configured)
- A **Check Failure** causes the next **Loop** to receive the failure output as
  additional context
- After loops complete, the **Agent Runner** checks for uncommitted work via
  **Container Session**'s `hasDirtyTree()`, issues a **Commit Nudge**, and falls
  back to **Auto-Commit** if needed
- A **Git Bundle** is created inside the **Container** via **Container
  Session**'s `extractBundle()` and extracted to the **Run Directory**
- A **Result Sink** receives the **Git Bundle** and **Source Metadata**,
  producing a **Sink Result**
- For `HostGit` strategy, the sink creates a **Result Branch** via `git fetch` —
  the host's checkout is never changed
- The **Base Image** ships with no user-facing runtimes; **Features** add
  runtimes on top of it
- The **Image Manager** builds the **Base Image**, installs **Features** (sorted
  alphabetically for deterministic caching), runs the **Prepare Command**, and
  commits the result as a **Cached Image**
- **Features** and **Custom Image** are mutually exclusive at any config level;
  the **Feature Registry** validates this at load time
- A **Cached Image** key is a SHA-256 hash of all inputs (Dockerfile content,
  Feature install script contents, Feature versions, Prepare Command); changing
  any input produces a new cache tag
- **Custom Images** without a **Prepare Command** are used directly; with a
  **Prepare Command** they produce a **Cached Image**
- The **Orchestrator** uses an **Image Resolver** to resolve per-item
  **Environment Config** to a Docker image; items with identical configs share
  the same **Cached Image**
- **Egress Filtering** is applied to the **Container** before the first **Loop**
  begins
- An **Orchestrator** loads a **Queue** via a **Queue Source** and produces a
  **Queue Report**
- An **Orchestrator** generates exactly one **Queue Run ID** per execution
- Each **Queue Item** produces one **Knox** engine run with its own **Run ID**
- **Queue Defaults** merge with per-item overrides; item values take precedence
  (for **Environment Config**, per-item fully replaces defaults — no merging)
- The **DAG** is validated at load time: cycles, dangling references, and
  group diamonds are rejected as **Validation Errors**
- A **Ready Item** is picked by the scheduler when a **Concurrency** slot is
  available
- A `failed` **Queue Item** transitively marks all downstream dependents as
  **Blocked**, with `blockedBy` recording the failed item's ID
- All items in a **Group** share a single **Group Branch**; commits stack in
  dependency order via **Chained Execution**
- The first item in a **Group** clones from HEAD; subsequent items clone from the
  **Group Branch** via `GitSourceProvider({ ref })`
- **Resume** preserves the **Queue Run ID** and **Queue State**; only
  non-`completed` items are re-evaluated
- **Item Logs** are written regardless of verbosity; the `--verbose` flag
  controls whether Agent output also appears on stderr
- **Queue State** is updated on every **Item Status** transition, so it reflects
  current progress even if the Orchestrator crashes
- The **Queue TUI** consumes **Knox Events** via the Orchestrator's `onEvent`
  callback and Agent output via `onLine`, maintaining **Display State** per item
- The **Static Renderer** consumes the same callbacks but renders timestamped
  lines instead of an ANSI table
- **Display State** is derived from **Knox Events** via a pure reducer
  (`applyEvent`), making the state machine testable without rendering
- The **Queue TUI** **Freezes** on stop — one final render, then no more
  clearing/redrawing — so the frozen table persists in scrollback above the
  summary
- A **Directory Queue Source** reads `.md` files from a directory, parsing each
  through the **Markdown Task Parser**; optional `_defaults.yaml` provides
  **Queue Defaults**
- **Frontmatter** fields map to **Queue Item** overrides; the **Task Body**
  becomes the `task` property
- The filename (minus `.md`) becomes the **Queue Item** `id`
- A **Queue Output** runs after all items complete: **Branch Queue Output** is a
  no-op, **Pull Request Queue Output** creates GitHub PRs via `gh` CLI
- **Queue Discovery** scans `.knox/queues/` and produces **Discovered Queues**
- The **Multi-Queue Runner** iterates **Discovered Queues** sequentially, each
  getting its own **Orchestrator** instance, renderer, and **Queue Output**
  callback
- **Knox Config** is loaded from `.knox/config.yaml`; **Output Strategy** can be
  overridden by CLI `--output` flag (flag wins over config)
- The CLI has three queue modes: `--file` (File Queue Source), `--name`
  (Directory Queue Source for a specific queue), and discovery mode (Multi-Queue
  Runner over all Discovered Queues)

## Example dialogue (updated)

> **Dev:** "How do I set up the environment for my tasks? I need Python and Deno."
> **Domain expert:** "Declare **Features** in your queue. In `_defaults.yaml`,
> list `features: [python:3.12, deno]`. The **Feature Registry** validates the
> names and versions, then the **Image Manager** installs them onto the **Base
> Image** in alphabetical order. The result is a **Cached Image** tagged by
> hash — same inputs, same cache hit."
>
> **Dev:** "What if I also need to install my project's pip packages?"
> **Domain expert:** "Add a **Prepare Command**: `prepare: 'pip install -r
> requirements.txt'`. It runs after **Features** are installed, still with
> network access. The **Prepare Command** is included in the cache key, so
> changing it busts the cache."
>
> **Dev:** "One of my tasks needs Rust instead of Python. How do I override?"
> **Domain expert:** "Set the **Environment Config** in that task's
> **Frontmatter**: `features: [rust:1.78]` and `prepare: 'cargo fetch'`. Per-item
> **Environment Config** fully replaces **Queue Defaults** — no merging. The
> **Image Resolver** in the **Orchestrator** builds a separate **Cached Image**
> for that item."
>
> **Dev:** "What if Knox's features don't cover my stack?"
> **Domain expert:** "Use the **Custom Image** escape hatch: `image:
> my-org/custom:latest`. You can combine it with a **Prepare Command**, but
> **Features** and **Custom Image** are mutually exclusive — Knox rejects configs
> with both."
>
> **Dev:** "How do I define a queue? I see both YAML files and Markdown
> directories."
> **Domain expert:** "Two **Queue Sources**. A **File Queue Source** reads a
> single YAML file — `knox queue --file tasks.yaml`. A **Directory Queue Source**
> reads a directory of `.md` files — each file becomes a **Queue Item**. The
> filename minus `.md` is the item `id`, the **Frontmatter** holds overrides like
> `dependsOn` or `group`, and the **Task Body** is the task description. Put an
> optional `_defaults.yaml` in the directory for **Queue Defaults**."
>
> **Dev:** "What if I have multiple queues?"
> **Domain expert:** "Put directories under `.knox/queues/`. When you run `knox
> queue` with no flags, **Queue Discovery** scans that path and finds all
> **Discovered Queues** — any subdirectory with at least one `.md` file. The
> **Multi-Queue Runner** executes them sequentially, each with its own
> **Orchestrator**. Or use `--name auth-refactor` to target a specific one."
>
> **Dev:** "What happens when a Queue Item fails?"
> **Domain expert:** "The **Orchestrator** marks it `failed` and walks the **DAG**
> to transitively mark all downstream dependents as **Blocked**. Independent items
> keep running. So in a diamond — A feeds B and C, both feed D — if B fails, D is
> **Blocked** but C still runs."

## Flagged ambiguities

- **"image"** has three meanings: the **Base Image** (`knox-agent:latest`), a
  **Cached Image** (`knox-cache:<hash>`), and a **Custom Image** (user-provided
  via `image:` field). Always qualify which one you mean.
- **"prompt"** can mean the user's Task description or the full instruction text
  built by the PromptBuilder. Use **Task** for the user's intent and **Prompt**
  for the constructed instruction file fed to Claude Code.
- **"sandbox"** appears in the PRD but not in the code. The codebase uses
  **Container** — prefer **Container** in all contexts.
- **"air-gapped"** was used in early commits but replaced with **Egress
  Filtering** — the Container is not truly air-gapped since DNS and API traffic
  are allowed.
- **"retry"** has two distinct meanings: the **Agent Runner** retries a failed
  Claude Code invocation (with exponential backoff, not counted against Max
  Loops), while a **Check Failure** causes the _next Loop_ (which _is_ counted).
  Distinguish between "retry" (transient error recovery) and "re-loop after
  Check Failure" (deliberate continuation).
- **"initial commit"** was previously used to mean the first commit inside the
  Container. This is now **Base Commit** — the host repo's HEAD SHA at snapshot
  time. Avoid "initial commit" as it conflates the host's history with the
  Container's.
- **"extractor" / "Result Extractor"** is the old module name. The concept has
  been split into **Git Bundle** (transfer mechanism) and **Result Sink** (output
  strategy). Avoid "extractor" — use **Result Sink** for the module and **Git
  Bundle** for the mechanism.
- **"fallback copy"** referred to dumping the Container workspace into the host
  project directory. This mechanism is removed. Do not use this term — if the
  **Git Bundle** fetch fails, it is an error, not a fallback.
- **"loop executor"** is the old module name. The concept has been absorbed into
  **Agent Runner**, which owns both loop management and commit recovery as a
  single coherent responsibility. Avoid "loop executor" — use **Agent Runner**.
- **"session" vs "container"**: A **Container** is the Docker environment. A
  **Container Session** is the Knox module that manages a Container's lifecycle.
  Do not use "session" alone — always say **Container Session** to avoid
  confusion with HTTP sessions or user sessions.
- **"setup"** is the former field name, now renamed to **Prepare Command**. The
  codebase rejects `setup` with a migration error directing users to `prepare`.
  Do not use "setup command" — always say **Prepare Command**. The legacy
  `ensureSetupImage` method is deprecated and delegates to `ensureFeatureImage`.
- **"Run ID"** now has two scopes: the per-engine **Run ID**
  (8-hex, one per Knox invocation) and the per-queue **Queue Run ID** (8-hex,
  one per Orchestrator execution). Always qualify: "Run ID" for engine scope,
  "Queue Run ID" for queue scope. Never use "Run ID" unqualified when both
  scopes are in play.
- **"state file"** can mean the **Queue State** file (`<name>.state.yaml`) or
  the **Progress File** (`knox-progress.txt` inside the Container). These are
  completely different: Queue State tracks item statuses across the queue;
  Progress File carries Agent context across Loops within a single Container.
  Always use the full term.
- **"source"** is used for both **Queue Source** (the data layer that loads queue
  manifests) and **Source Provider** (the git cloning mechanism). These are
  unrelated interfaces at different layers. Always use the full term to
  disambiguate.
- **"branch"** can mean a **Result Branch** (per-item, named
  `knox/<slug>-<runId>`) or a **Group Branch** (per-group, named
  `knox/<group>-<queueRunId>`). In queue contexts, always specify which.
  Ungrouped Queue Items produce **Result Branches**; grouped items produce
  **Group Branches**.
- **"blocked"** has a specific meaning: a Queue Item that cannot run because a
  dependency failed. Do not use "blocked" for items waiting on non-failed
  dependencies — those are simply `pending` with unsatisfied deps. Also do not
  confuse with abort-blocked items (whose `blockedBy` is `"aborted"` rather than
  an item ID).
- **"in_progress" vs "running"**: The Orchestrator uses `in_progress` as the
  **Item Status** value, while the **Queue TUI** uses `running` as the **Display
  Status**. These represent the same lifecycle phase at different layers. Use
  **In Progress** for the domain/orchestrator layer and **Running** for the
  display layer.
- **"aborted" representation**: The **Display Status** enum has an explicit
  `aborted` value. The **Item Status** enum does not — abort is represented as
  `blocked` with `blockedBy: "aborted"`. This asymmetry is intentional: the
  domain model treats abort as a blocking cause, while the TUI treats it as a
  distinct visual state.
- **"onEvent" vs "update"**: The Orchestrator exposes `onEvent(itemId, event)` as
  a callback option. The **Queue TUI** receives this as its `update(itemId,
  event)` method. Same data flow, different names at different layers.
- **"onLine" vs "appendLine"**: Same pattern — the Orchestrator exposes
  `onLine(itemId, line)`, which maps to the **Queue TUI**'s `appendLine(itemId,
  line)`.
- **"output"** has three distinct meanings: **Queue Output** (interface for
  post-queue delivery), **Output Strategy** (the `"branch"` or `"pr"` enum from
  Knox Config), and the `--output` CLI flag. The interface decides *how* to
  deliver; the strategy decides *what* to deliver. Always qualify.
- **"queue source" vs "source provider"**: Both are "source" abstractions at
  different layers. **Queue Source** loads queue manifests (data layer). **Source
  Provider** prepares git source for containers (engine layer). The word "source"
  alone is ambiguous — always use the full term.
- **"queue" CLI modes**: The `knox queue` command has three mutually exclusive
  modes: `--file` (File Queue Source), `--name` (Directory Queue Source for a
  named queue), and bare (Queue Discovery + Multi-Queue Runner). These are not
  interchangeable.
- **"features" vs "Feature"** (new): Lowercase `features` is the YAML/config
  field (an array of strings). Capitalized **Feature** is the domain concept — a
  Knox-maintained install script with metadata. In code, `FeatureConfigEntry` is
  the raw config value; **Resolved Feature** is the validated, ready-to-install
  form.
- **"environment"** (new): Can mean the Docker container environment
  (**Environment Config**: features + prepare + image), OS environment variables
  (`env` field on Queue Item), or the host system. Use **Environment Config**
  when referring to the container setup declaration. Use "env vars" or
  "environment variables" for the `env` field.
