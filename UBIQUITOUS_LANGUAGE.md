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

| Term                    | Definition                                                                                                                                      | Aliases to avoid      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **Run ID** (new)        | An 8-hex-character identifier generated at the start of each Knox run, used to correlate Container, branch, temp directory, and result metadata | Job ID, session ID    |
| **Run Directory** (new) | The temporary directory `/tmp/knox-<Run ID>/` that holds all artifacts for a single run                                                         | Temp dir, working dir |

## Source & Sink

| Term                      | Definition                                                                                                                      | Aliases to avoid                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Source Provider** (new) | Container-agnostic interface that prepares source material on the host for injection into a Container                           | Input strategy, source strategy             |
| **Source Metadata** (new) | A discriminated union describing how source was prepared, keyed on Source Strategy (e.g., base commit, repo path)               | Source info, source context                 |
| **Source Strategy** (new) | An enum member identifying which Source Provider produced the Source Metadata (MVP: `HostGit`)                                  | Source type                                 |
| **Result Sink** (new)     | Container-agnostic interface that receives a Git Bundle and produces a SinkResult                                               | Output strategy, result strategy, extractor |
| **Sink Result** (new)     | A discriminated union describing the outcome of a Result Sink, keyed on Sink Strategy (e.g., branch name for HostGit)           | Extract result, output result               |
| **Sink Strategy** (new)   | An enum member identifying which Result Sink produced the Sink Result (MVP: `HostGit`; future: `RemoteGit`, `Filesystem`, `PR`) | Sink type, output type                      |

## Transfer Mechanism

| Term                        | Definition                                                                                                                                    | Aliases to avoid                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Git Bundle** (new)        | A portable file containing git objects, created inside the Container and fetched on the host to create a Result Branch                        | Patch file, format-patch, archive                                                  |
| **Base Commit** (new)       | The host repo's HEAD SHA at the time Source Provider snapshots the code; the anchor point for the Result Branch                               | Initial commit (overloaded — was previously used for the container's first commit) |
| **Shallow Clone** (new)     | A `git clone --depth 1` of the host repo used to prepare source; ensures the Agent sees only committed state at HEAD with no history          | Snapshot, archive, export                                                          |
| **Result Branch** (updated) | A git branch named `knox/<Task Slug>-<Run ID>` on the host repo containing the Agent's commits, created without switching the host's checkout | Output branch                                                                      |

## Commit Recovery

| Term                      | Definition                                                                                                                                                            | Aliases to avoid               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Commit Nudge** (new)    | A lightweight, single-purpose Claude invocation that instructs the Agent to review its diff and commit with a meaningful message, without making further code changes | Commit reminder, commit retry  |
| **Auto-Commit** (updated) | A mechanical `git add -A && git commit` performed by Knox as a last resort when the Agent fails to commit after a Commit Nudge                                        | Fallback commit, safety commit |

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

## Orchestration

| Term                | Definition                                                                                                                    | Aliases to avoid                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Knox**            | The top-level orchestrator that coordinates preflight, source provision, Agent execution, commit recovery, and result sinking | Runner, executor (when meaning the whole system) |
| **Preflight Check** | A validation run before execution: Docker available, Credentials present, source directory exists, dirty working tree warning | Pre-check, startup validation                    |
| **Loop Executor**   | The module that runs Agent Loops with retry and exponential backoff                                                           | Agent runner                                     |
| **Image Manager**   | The module that builds the base Image and caches Setup Images                                                                 | Builder, image builder                           |

## Relationships

- A **Knox** run generates exactly one **Run ID** and one **Run Directory**
- A **Knox** run executes exactly one **Task** inside one **Container** named
  `knox-<Run ID>`
- A **Source Provider** prepares source material into the **Run Directory**,
  producing **Source Metadata** with a **Base Commit**
- Source is injected into the **Container** via **Shallow Clone** — committed
  state only, no history
- A **Task** produces one or more **Loops**, up to **Max Loops**
- Each **Loop** is a fresh Claude Code invocation; the **Progress File** carries
  context between them
- A **Loop** may emit a **Completion Signal**, which triggers the **Check
  Command** (if configured)
- A **Check Failure** causes the next **Loop** to receive the failure output as
  additional context
- After loops complete, if the Agent has uncommitted work, Knox issues a
  **Commit Nudge**
- If the **Commit Nudge** fails, Knox performs an **Auto-Commit**
- A **Git Bundle** is created inside the **Container** and extracted to the
  **Run Directory**
- A **Result Sink** receives the **Git Bundle** and **Source Metadata**,
  producing a **Sink Result**
- For `HostGit` strategy, the sink creates a **Result Branch** via `git fetch` —
  the host's checkout is never changed
- A **Setup Command** produces a **Setup Image** cached by its SHA256 hash
- **Egress Filtering** is applied to the **Container** before the first **Loop**
  begins

## Example dialogue

> **Dev:** "When I kick off a Knox run, what actually gets copied into the
> Container?" **Domain expert:** "Only committed state. The **Source Provider**
> does a **Shallow Clone** — `git clone --depth 1` — so the Agent sees the tree
> at HEAD but no history. If you have uncommitted changes, Preflight warns you
> but proceeds."
>
> **Dev:** "Why no history? Wouldn't `git blame` help the Agent?" **Domain
> expert:** "Security. History might contain reverted secrets or credentials in
> old diffs. The Agent gets the least access possible — one commit, one tree."
>
> **Dev:** "What if the Agent finishes but forgets to commit?" **Domain
> expert:** "Knox checks for dirty files after the loops. If there are any, it
> runs a **Commit Nudge** — a narrow Claude invocation that just reviews the
> diff and writes a commit message. No more coding. If the Agent still doesn't
> commit, Knox does an **Auto-Commit** mechanically."
>
> **Dev:** "And how does the work get back to my repo?" **Domain expert:** "Knox
> creates a **Git Bundle** inside the Container, copies it to the **Run
> Directory**, then the **Result Sink** fetches it into your repo as a **Result
> Branch** — `knox/<slug>-<Run ID>`. Your checkout doesn't change. You review
> with `git log` and merge when ready."
>
> **Dev:** "What if I want to send the results somewhere else — like push to a
> remote?" **Domain expert:** "Implement a different **Result Sink**. The
> interface is container-agnostic — it just receives a bundle path and **Source
> Metadata**. Knox doesn't care where the work ends up."

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
- **"retry"** has two distinct meanings: the **Loop Executor** retries a failed
  Claude Code invocation (with exponential backoff, not counted against Max
  Loops), while a **Check Failure** causes the _next Loop_ (which _is_ counted).
  Distinguish between "retry" (transient error recovery) and "re-loop after
  Check Failure" (deliberate continuation).
- **"initial commit"** (flagged, new) was previously used to mean the first
  commit inside the Container. This is now **Base Commit** — the host repo's
  HEAD SHA at snapshot time. Avoid "initial commit" as it conflates the host's
  history with the Container's.
- **"extractor" / "Result Extractor"** (flagged, new) is the old module name.
  The concept has been split into **Git Bundle** (transfer mechanism) and
  **Result Sink** (output strategy). Avoid "extractor" — use **Result Sink** for
  the module and **Git Bundle** for the mechanism.
- **"fallback copy"** (flagged, new) referred to dumping the Container workspace
  into the host project directory. This mechanism is removed. Do not use this
  term — if the **Git Bundle** fetch fails, it is an error, not a fallback.
