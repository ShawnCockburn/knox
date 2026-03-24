# Ubiquitous Language

## Sandbox & Execution

| Term                  | Definition                                                                                             | Aliases to avoid                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **Container**         | An isolated Docker environment where the Agent executes a Task                                         | Sandbox, VM, box                                                  |
| **Container Runtime** | Abstract interface for container operations (build, exec, copy, restrict network)                      | Docker (when referring to the abstraction)                        |
| **Workspace**         | The `/workspace` directory inside the Container where source code lives and the Agent works            | Workdir, working directory                                        |
| **Image**             | A Docker image containing Node.js, Claude Code CLI, git, and required tools                            | Base image (unless referring specifically to the pre-setup image) |
| **Setup Image**       | A cached snapshot of a Container after the Setup Command has run, tagged by SHA256 hash of the command | Cache image, cached image                                         |

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
| **Result Branch** (updated) | A git branch on the host repo containing the Agent's commits, created without switching the host's checkout; named `knox/<Task Slug>-<Run ID>` for single runs, or **Group Branch** for grouped Queue Items | Output branch                                                                      |

## Commit Recovery

| Term              | Definition                                                                                                                                                            | Aliases to avoid               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Commit Nudge**  | A lightweight, single-purpose Claude invocation that instructs the Agent to review its diff and commit with a meaningful message, without making further code changes | Commit reminder, commit retry  |
| **Auto-Commit**   | A mechanical `git add -A && git commit` performed by Knox as a last resort when the Agent fails to commit after a Commit Nudge                                        | Fallback commit, safety commit |

## Two-Phase Execution

| Term                 | Definition                                                                                             | Aliases to avoid                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| **Setup Command**    | An optional user-provided command (e.g., `npm install`) run with network access before the Agent phase | Install command, init command                               |
| **Egress Filtering** | Network restriction allowing only HTTPS to Anthropic API endpoints and DNS; applied via iptables       | Air-gapped (inaccurate — DNS and API are allowed), firewall |
| **Allowed IPs**      | The set of resolved IP addresses for Anthropic API endpoints that Egress Filtering permits             | Whitelist                                                   |

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

| Term                            | Definition                                                                                                                    | Aliases to avoid                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Knox** (updated)              | The single-run engine that coordinates a Container Session, Agent Runner, bundle extraction, and result sinking for one Task | Runner, executor (when meaning the whole system) |
| **Knox Outcome**                | A discriminated union result from a Knox engine run: `{ ok: true, result }` or `{ ok: false, error, phase }`                 | Result (ambiguous with KnoxResult)               |
| **Preflight Check**             | A validation run before execution: Docker available, Credentials present, source directory exists, dirty working tree warning | Pre-check, startup validation                    |
| **Container Session**           | A deep module that owns the entire lifecycle of a sandboxed Container: creation, workspace setup, command execution, result extraction, and cleanup | Session, sandbox context                         |
| **Agent Runner**                | A deep module that owns Agent execution as a coherent operation: running Loops, detecting the Completion Signal, verifying Check Commands, and performing Commit Nudge with Auto-Commit fallback | Loop executor, agent loop                        |
| **Image Manager**               | The module that builds the base Image and caches Setup Images                                                                 | Builder, image builder                           |
| ~~**Loop Executor**~~ (removed) | Absorbed into **Agent Runner**, which owns both loop management and commit recovery as a single responsibility               | —                                                |

## Queue Orchestration (new)

| Term | Definition | Aliases to avoid |
| ---- | ---------- | ---------------- |
| **Queue** (new) | A YAML manifest describing multiple Tasks to be executed, with optional dependencies, groups, concurrency, and defaults | Batch, job list, task list |
| **Queue Item** (new) | A single entry in a Queue, consisting of an `id`, a `task` description, and optional overrides for model, setup, check, env, etc. | Task (when referring to the queue entry rather than the work description), job |
| **Queue Defaults** (new) | Queue-level configuration values (model, maxLoops, env, etc.) that merge with per-item overrides; item values take precedence | Global config, base config |
| **Queue Source** (new) | Interface for loading a Queue and persisting Queue State; the data layer for the Orchestrator | Queue loader, queue provider |
| **File Queue Source** (new) | YAML-file-backed implementation of Queue Source; reads from `<name>.yaml`, writes state to `<name>.state.yaml` | YAML loader |
| **Queue State** (new) | A persistent record of a Queue Run's progress, stored in a `.state.yaml` file alongside the Queue file | State file (ambiguous with Progress File), checkpoint |
| **Item Status** (new) | The lifecycle state of a Queue Item: `pending`, `in_progress`, `completed`, `failed`, or `blocked` | Status, state (too generic) |
| **Queue Run ID** (new) | An 8-hex-character identifier for an entire Queue execution, distinct from per-item Run IDs | Run ID (ambiguous — see flagged ambiguities) |
| **Orchestrator** (new) | The component that loads a Queue, schedules Queue Items via the DAG Scheduler, invokes Knox for each item, tracks Queue State, and produces a Queue Report | Queue runner, batch runner, scheduler (the scheduler is a part of the Orchestrator, not the whole) |
| **DAG** (new) | The directed acyclic graph of dependencies formed by `dependsOn` declarations between Queue Items | Dependency tree (inaccurate — it's a graph, not a tree), dep graph |
| **Ready Item** (new) | A Queue Item whose status is `pending` and whose dependencies have all reached `completed` status | Runnable item, eligible item |
| **Blocked** (new) | An Item Status meaning the item cannot run because a direct or transitive dependency has `failed` | Skipped (inaccurate — skipped implies intentional), cancelled |
| **Group** (new) | A named set of Queue Items that form a linear chain producing a single branch with stacked commits | Chain, pipeline, sequence |
| **Group Branch** (new) | The shared Result Branch for all items in a Group, named `knox/<group>-<Queue Run ID>` | Shared branch, chain branch |
| **Chained Execution** (new) | The mechanism where each subsequent item in a Group clones from the Group Branch (its predecessor's output) via Source Provider `ref` parameter | Stacking, sequential build |
| **Concurrency** (new) | The maximum number of Queue Items that may run simultaneously, configured at the Queue level (default: 1) | Parallelism, workers, pool size |
| **Resume** (new) | Re-running an Orchestrator from an existing Queue State: `completed` items are skipped, `failed` and `blocked` items are reset to `pending` | Retry (ambiguous with transient error retry), restart |
| **Queue Report** (new) | The final JSON output of an Orchestrator run, printed to stdout, containing all item statuses, branches, durations, and outcomes | Summary (ambiguous with stderr summary), results |
| **Item Log** (new) | A per-item text file capturing all Agent output, written to `<queue-name>.logs/<item-id>.log` regardless of verbosity | Log file (too generic) |
| **Validation Error** (new) | A structural, referential, cycle, or group-linearity error detected at Queue load time; all errors are collected before reporting | Parse error (too narrow) |

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
- A **Setup Command** produces a **Setup Image** cached by its SHA256 hash
- **Egress Filtering** is applied to the **Container** before the first **Loop**
  begins
- An **Orchestrator** loads a **Queue** via a **Queue Source** and produces a
  **Queue Report** (new)
- An **Orchestrator** generates exactly one **Queue Run ID** per execution (new)
- Each **Queue Item** produces one **Knox** engine run with its own **Run ID**
  (new)
- **Queue Defaults** merge with per-item overrides; item values take precedence
  (new)
- The **DAG** is validated at load time: cycles, dangling references, and
  group diamonds are rejected as **Validation Errors** (new)
- A **Ready Item** is picked by the scheduler when a **Concurrency** slot is
  available (new)
- A `failed` **Queue Item** transitively marks all downstream dependents as
  **Blocked**, with `blockedBy` recording the failed item's ID (new)
- All items in a **Group** share a single **Group Branch**; commits stack in
  dependency order via **Chained Execution** (new)
- The first item in a **Group** clones from HEAD; subsequent items clone from the
  **Group Branch** via `GitSourceProvider({ ref })` (new)
- **Resume** preserves the **Queue Run ID** and **Queue State**; only
  non-`completed` items are re-evaluated (new)
- **Item Logs** are written regardless of verbosity; the `--verbose` flag
  controls whether Agent output also appears on stderr (new)
- **Queue State** is updated on every **Item Status** transition, so it reflects
  current progress even if the Orchestrator crashes (new)
- The **Queue TUI** consumes **Knox Events** via the Orchestrator's `onEvent`
  callback and Agent output via `onLine`, maintaining **Display State** per item
  (new)
- The **Static Renderer** consumes the same callbacks but renders timestamped
  lines instead of an ANSI table (new)
- **Display State** is derived from **Knox Events** via a pure reducer
  (`applyEvent`), making the state machine testable without rendering (new)
- The **Queue TUI** **Freezes** on stop — one final render, then no more
  clearing/redrawing — so the frozen table persists in scrollback above the
  summary (new)

## Example dialogue

> **Dev:** "How does queue mode differ from a single `knox run`?"
> **Domain expert:** "A single `knox run` invokes **Knox** once — one **Task**,
> one **Container**, one **Result Branch**. Queue mode loads a **Queue** manifest
> and runs an **Orchestrator** that schedules multiple **Queue Items** against the
> same engine. Shared resources — **Image**, **Credentials**, **Allowed IPs** —
> are resolved once for the whole queue."
>
> **Dev:** "What happens when a Queue Item fails?"
> **Domain expert:** "The **Orchestrator** marks it `failed` and walks the **DAG**
> to transitively mark all downstream dependents as **Blocked**. Independent items
> keep running. So in a diamond — A feeds B and C, both feed D — if B fails, D is
> **Blocked** but C still runs."
>
> **Dev:** "What about groups? I see items with the same `group` field."
> **Domain expert:** "A **Group** is a linear chain. All items share one **Group
> Branch** named `knox/<group>-<Queue Run ID>`. The first item clones from HEAD.
> Each subsequent item uses **Chained Execution** — it clones from the **Group
> Branch**, so it sees its predecessor's commits. The **Result Sink** stacks
> commits onto the same branch."
>
> **Dev:** "Can I resume a partially-completed queue?"
> **Domain expert:** "Yes. `--resume` reads the existing **Queue State** file.
> `completed` items are skipped. `failed` and **Blocked** items are reset to
> `pending`. The **Queue Run ID** is preserved so **Group Branches** from the
> previous run are continued, not recreated."
>
> **Dev:** "Where do I find what happened?"
> **Domain expert:** "Three places. Lifecycle events go to stderr always. Each
> item's Agent output goes to an **Item Log** in `<queue>.logs/<id>.log`. The
> **Queue Report** — full JSON with all outcomes — goes to stdout."
>
> **Dev:** "What does the user see while the queue is running?"
> **Domain expert:** "If stderr is a TTY, the **Queue TUI** renders a live status
> table. Each item gets a row with a **Spinner** for running items, a **Phase**
> label like 'loop 2/5', and elapsed time. The header shows aggregate counts.
> With `--verbose`, a **Log Panel** below the table shows interleaved Agent
> output with color-coded item prefixes. In CI or with `--no-tui`, the **Static
> Renderer** prints one timestamped line per **Knox Event** instead."
>
> **Dev:** "What about Ctrl+C?"
> **Domain expert:** "The `AbortSignal` fires. Running items emit an `aborted`
> **Knox Event**. The **Queue TUI** updates their **Display Status** to `aborted`,
> renders one final frame, then **Freezes**. Remaining pending items become
> **Blocked** with `blockedBy: 'aborted'`. The summary prints below the frozen
> frame."

## Queue TUI (new)

| Term | Definition | Aliases to avoid |
| ---- | ---------- | ---------------- |
| **Queue TUI** (new) | The live-updating ANSI table rendered to stderr showing real-time Queue progress with spinner, colors, and status counts | Dashboard, UI, display |
| **Static Renderer** (new) | The non-interactive fallback that prints timestamped `[HH:MM:SS] [item-id] <description>` log lines to stderr, used in non-TTY or `--no-tui` mode | Static fallback, plain renderer, plain mode |
| **Display State** (new) | The TUI's per-item view model, derived from Knox Events via a pure reducer function (`applyEvent`) | View state, render state |
| **Display Status** (new) | The TUI's status enum: `pending`, `running`, `completed`, `failed`, `blocked`, `aborted` — a superset of Item Status that adds `aborted` as a first-class visual state and renames `in_progress` to `running` | Render status |
| **Phase** (new) | A human-readable label describing the current activity of a running item (e.g., "setting up", "loop 2/5", "check failed, retrying", "extracting results") | Step, stage, activity |
| **Spinner** (new) | The animated braille indicator (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) cycling at 80ms for running items in the Queue TUI | Loading indicator, progress indicator |
| **Log Panel** (new) | The scrolling area below the status table showing live Agent output lines in `--verbose` TUI mode, with color-coded item ID prefixes | Output panel, console, verbose panel |
| **Freeze** (new) | The act of stopping TUI redraws so the final frame persists in terminal scrollback; occurs on normal completion or Ctrl+C | Lock, stop rendering, persist |

## Flagged ambiguities

- **"image"** is used for both the base `knox-agent:latest` image and the
  post-setup cached image. Use **Image** for the base and **Setup Image** for
  the cached post-setup snapshot.
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
- **"Run ID"** (flagged, new) now has two scopes: the per-engine **Run ID**
  (8-hex, one per Knox invocation) and the per-queue **Queue Run ID** (8-hex,
  one per Orchestrator execution). Always qualify: "Run ID" for engine scope,
  "Queue Run ID" for queue scope. Never use "Run ID" unqualified when both
  scopes are in play.
- **"state file"** (flagged, new) can mean the **Queue State** file
  (`<name>.state.yaml`) or the **Progress File** (`knox-progress.txt` inside
  the Container). These are completely different: Queue State tracks item
  statuses across the queue; Progress File carries Agent context across Loops
  within a single Container. Always use the full term.
- **"source"** (flagged, new) is used for both **Queue Source** (the data layer
  that loads queue YAML) and **Source Provider** (the git cloning mechanism).
  These are unrelated interfaces at different layers. Always use the full term
  to disambiguate.
- **"branch"** (flagged, new) can mean a **Result Branch** (per-item, named
  `knox/<slug>-<runId>`) or a **Group Branch** (per-group, named
  `knox/<group>-<queueRunId>`). In queue contexts, always specify which.
  Ungrouped Queue Items produce **Result Branches**; grouped items produce
  **Group Branches**.
- **"blocked"** (flagged, new) has a specific meaning: a Queue Item that cannot
  run because a dependency failed. Do not use "blocked" for items waiting on
  non-failed dependencies — those are simply `pending` with unsatisfied deps.
  Also do not confuse with abort-blocked items (whose `blockedBy` is `"aborted"`
  rather than an item ID).
- **"in_progress" vs "running"** (flagged, new): The Orchestrator uses
  `in_progress` as the **Item Status** value, while the **Queue TUI** uses
  `running` as the **Display Status**. These represent the same lifecycle phase
  at different layers. Use **In Progress** for the domain/orchestrator layer and
  **Running** for the display layer. Do not use "running" when referring to
  orchestrator state, or "in_progress" in TUI code.
- **"aborted" representation** (flagged, new): The **Display Status** enum has
  an explicit `aborted` value. The **Item Status** enum does not — abort is
  represented as `blocked` with `blockedBy: "aborted"`. This asymmetry is
  intentional: the domain model treats abort as a blocking cause, while the TUI
  treats it as a distinct visual state worth its own icon and color.
- **"onEvent" vs "update"** (flagged, new): The Orchestrator exposes
  `onEvent(itemId, event)` as a callback option. The **Queue TUI** receives this
  as its `update(itemId, event)` method. Same data flow, different names at
  different layers. The callback name is `onEvent`; the TUI method is `update`.
- **"onLine" vs "appendLine"** (flagged, new): Same pattern — the Orchestrator
  exposes `onLine(itemId, line)`, which maps to the **Queue TUI**'s
  `appendLine(itemId, line)`. The callback name is `onLine`; the TUI method is
  `appendLine`.
