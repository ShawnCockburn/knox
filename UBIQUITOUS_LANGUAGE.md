# Ubiquitous Language

## Sandbox & Execution

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Container** | An isolated Docker environment where the Agent executes a Task | Sandbox, VM, box |
| **Container Runtime** | Abstract interface for container operations (build, exec, copy, restrict network) | Docker (when referring to the abstraction) |
| **Workspace** | The `/workspace` directory inside the Container where source code lives and the Agent works | Workdir, working directory |
| **Image** | A Docker image containing Node.js, Claude Code CLI, git, and required tools | Base image (unless referring specifically to the pre-setup image) |
| **Setup Image** | A cached snapshot of a Container after the Setup Command has run, tagged by SHA256 hash of the command | Cache image, cached image |

## Agent & Task

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Agent** | The Claude Code instance running autonomously inside the Container | Bot, worker, runner |
| **Task** | A user-provided description of work for the Agent to complete | Job, prompt (when meaning the user's intent) |
| **Task Slug** | A URL-safe transformation of the Task description, used for branch names and output directories | Task ID, task key |
| **Loop** | A single invocation of Claude Code inside the Container; the Agent may run across multiple Loops | Iteration, cycle, round |
| **Max Loops** | The upper bound on Loop count before Knox stops and extracts partial results (default: 10) | Max iterations, loop limit |
| **Completion Signal** | The sentinel string `KNOX_COMPLETE` output by the Agent to indicate the Task is finished | Done marker, exit signal |
| **Progress File** | The persistent file `knox-progress.txt` inside the Container that carries context across Loops | State file, log file, memory file |

## Two-Phase Execution

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Setup Command** | An optional user-provided command (e.g., `npm install`) run with network access before the Agent phase | Install command, init command |
| **Egress Filtering** | Network restriction allowing only HTTPS to Anthropic API endpoints and DNS; applied via iptables | Air-gapped (inaccurate — DNS and API are allowed), firewall |
| **Allowed IPs** | The set of resolved IP addresses for Anthropic API endpoints that Egress Filtering permits | Whitelist |

## Authentication

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Credential** | An OAuth token or API key used to authenticate the Agent with the Claude API | Auth, secret, token (alone) |
| **Credential Provider** | Platform-specific implementation that retrieves Credentials (Keychain on macOS, file on Linux) | Auth provider |
| **Credential Resolution** | The process of finding a valid Credential: check env var first, then platform Credential Provider | Auth flow, login |

## Result Extraction

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Extract** | The process of pulling the Agent's git commits from the Container and applying them to the host repo | Export, copy out (when referring to the full git patch flow) |
| **Initial Commit** | The HEAD commit recorded before the Agent starts; used as the baseline for Extraction | Baseline, starting point |
| **Result Branch** | A git branch named `knox/<Task Slug>` on the host repo containing the Agent's commits | Output branch |
| **Fallback Copy** | Non-git Extraction: copying the entire Container workspace to a host directory when patch application fails | Raw copy, directory dump |

## Verification

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Check Command** | An optional user-provided command (e.g., `npm test`) run after the Agent signals completion | Verification command, test command |
| **Check Failure** | When the Check Command exits non-zero, indicating the Agent's Completion Signal was premature | False completion, failed verification |

## Orchestration

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Knox** | The top-level orchestrator that coordinates preflight, image management, Agent execution, and Extraction | Runner, executor (when meaning the whole system) |
| **Preflight Check** | A validation run before execution: Docker available, Credentials present, source directory exists | Pre-check, startup validation |
| **Loop Executor** | The module that runs Agent Loops with retry and exponential backoff | Agent runner |
| **Image Manager** | The module that builds the base Image and caches Setup Images | Builder, image builder |
| **Result Extractor** | The module that performs Extraction of Agent commits to the host | Extractor |

## Relationships

- A **Knox** run executes exactly one **Task** inside one **Container**
- A **Task** produces one or more **Loops**, up to **Max Loops**
- Each **Loop** is a fresh Claude Code invocation; the **Progress File** carries context between them
- A **Loop** may emit a **Completion Signal**, which triggers the **Check Command** (if configured)
- A **Check Failure** causes the next **Loop** to receive the failure output as additional context
- **Extraction** converts **Agent** commits (after **Initial Commit**) into a **Result Branch** on the host
- If **Extraction** fails, **Fallback Copy** writes the raw workspace to disk instead
- A **Setup Command** produces a **Setup Image** cached by its SHA256 hash
- **Egress Filtering** is applied to the **Container** before the first **Loop** begins

## Example dialogue

> **Dev:** "When I run Knox with a **Setup Command**, does the **Agent** see the installed dependencies?"
> **Domain expert:** "Yes. The **Setup Command** runs with full network access and the result is committed as a **Setup Image**. When the **Container** starts from that image, all installed packages are already there."
>
> **Dev:** "What happens if the **Agent** outputs **KNOX_COMPLETE** but the **Check Command** fails?"
> **Domain expert:** "That's a **Check Failure**. Knox feeds the failure output into the next **Loop's** prompt so the **Agent** can fix the problem. The **Loop** counter still increments — the **Agent** doesn't get infinite retries."
>
> **Dev:** "And if it hits **Max Loops** without completing?"
> **Domain expert:** "Knox runs **Extraction** anyway. You get a **Result Branch** with whatever partial commits the **Agent** made. Exit code 1 tells you it didn't finish."
>
> **Dev:** "Can the **Agent** reach the internet during a **Loop**?"
> **Domain expert:** "Only the Anthropic API. **Egress Filtering** blocks everything else — the **Container** has iptables rules that allow DNS and HTTPS to the **Allowed IPs** only."

## Flagged ambiguities

- **"image"** is used for both the base `knox-agent:latest` image and the post-setup cached image. Use **Image** for the base and **Setup Image** for the cached post-setup snapshot.
- **"prompt"** can mean the user's Task description or the full instruction text built by the PromptBuilder. Use **Task** for the user's intent and **Prompt** for the constructed instruction file fed to Claude Code.
- **"sandbox"** appears in the PRD but not in the code. The codebase uses **Container** — prefer **Container** in all contexts.
- **"air-gapped"** was used in early commits but replaced with **Egress Filtering** — the Container is not truly air-gapped since DNS and API traffic are allowed.
- **"retry"** has two distinct meanings: the **Loop Executor** retries a failed Claude Code invocation (with exponential backoff, not counted against Max Loops), while a **Check Failure** causes the *next Loop* (which *is* counted). Distinguish between "retry" (transient error recovery) and "re-loop after Check Failure" (deliberate continuation).
