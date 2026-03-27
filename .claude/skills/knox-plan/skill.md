---
name: knox-plan
description: Decompose a high-level goal (or PRD) into a Knox queue directory of task files. Use when user wants to plan a Knox queue, decompose a goal into tasks, create a .knox/queues directory, or mentions "knox queue".
---

Decompose a high-level goal into a Knox queue directory under `.knox/queues/`.

## Invocation

```
/knox-plan "refactor auth into interface + provider + tests"
/knox-plan ./prd/008-composable-queue-workflow.md
```

The argument may be:
- A **goal string** — extract everything after `/knox-plan` as the goal
- A **PRD file path** — use the PRD content as the source of truth and skip the interview

---

## Step 1 — Explore the codebase

Before asking the user anything, explore the project to gather defaults:

- Read any existing `_defaults.yaml` files under `.knox/queues/` to understand current conventions (model, concurrency, setup, check, maxLoops)
- Read the `README.md` or any `CLAUDE.md` for the project's standard build/test commands
- If a PRD path was provided, read that file now
- Look at 1–2 existing task files to understand the depth and style already in use

Use what you find to pre-fill sensible defaults so you ask fewer questions.

---

## Step 2 — Interview (goal string only; skip if PRD provided)

Ask the following questions **one at a time**. For each, propose an answer based on what you found in the codebase and ask the user to confirm or correct.

1. **Scope**: What files or modules are in scope? Are there any to avoid?
   > *Suggest based on the goal and what you found in the codebase.*

2. **Dependencies**: Are there tasks that must happen strictly before others?
   > *Suggest a rough ordering based on the goal.*

3. **Grouping**: Should any tasks share a branch (stacked commits)?
   > *Suggest groupings for tasks that form a coherent logical feature.*

4. **Setup command**: Is there a setup command needed (e.g., `deno cache`, `npm install`)?
   > *Suggest the command found in `_defaults.yaml` or README, or "none" if not found.*

5. **Check command**: Is there a verification command (e.g., `deno task check`, `npm test`)?
   > *Suggest the command found in `_defaults.yaml` or README, or "none" if not found.*

6. **Max loops**: How many agent loop iterations per task?
   > *Suggest the value from `_defaults.yaml`, or 10 if not found.*

Wait for the user's answer to each question before asking the next.

---

## Step 3 — Propose

Based on the goal (or PRD) and confirmed answers, decompose into tasks. Present clearly:

### Proposed: `<queue-name>`

**Queue name:** `<kebab-case-slug-derived-from-goal>`

**Defaults:**
```yaml
model: sonnet
concurrency: 2
setup: "<setup command or none>"
check: "<check command or none>"
maxLoops: <n>
```

**Tasks:**

| # | Task ID | Group | Depends On | Description |
|---|---------|-------|------------|-------------|
| 1 | `task-id` | `group-name` | — | One-line summary |
| 2 | `task-id` | `group-name` | `task-1` | One-line summary |

**Dependency graph (DAG):**

```
task-1 ──► task-3 ──► task-5
task-2 ──► task-3
task-4 ──► task-5
```

**Groups:**
- `group-name`: task-A → task-B → task-C (stacked commits on one branch)
- Tasks without a group each get their own branch.

Then ask:
> Does this decomposition look right? Any tasks to add, remove, rename, or re-group? Reply "yes" to generate the queue, or describe your changes.

Wait for approval before proceeding to Step 4.

---

## Step 4 — Write Queue Directory

Once the user confirms (or after applying adjustments), generate the queue directory.

### Queue name derivation

Convert the goal to a kebab-case slug:
- Lowercase
- Replace spaces, slashes, underscores, and special characters with hyphens
- Collapse repeated hyphens
- Trim leading/trailing hyphens
- Max 40 characters

Examples:
- `"refactor auth into interface + provider + tests"` → `refactor-auth-interface-provider-tests`
- `"Fix the flaky pagination test"` → `fix-flaky-pagination-test`

### Directory structure

```
.knox/queues/<queue-name>/
  _defaults.yaml
  <task-id-1>.md
  <task-id-2>.md
  ...
```

### `_defaults.yaml` format

```yaml
concurrency: 2
defaults:
  model: sonnet
  setup: "npm install"   # omit if none
  check: "npm test"      # omit if none
  maxLoops: 10
```

Only include `setup`, `check`, or `maxLoops` if they were specified. Always include `model: sonnet` and `concurrency`.

### Per-task `.md` file format

Each task file is named `<task-id>.md` with YAML frontmatter followed by a task description:

```markdown
---
id: task-id
dependsOn: [dep-1, dep-2]   # omit if no dependencies
group: group-name            # omit if no group
---

<Detailed task description here>
```

**Task description guidelines:**
- Describe *what behavior to implement*, not which files to touch — the agent discovers files itself
- Include the goal, key requirements, expected inputs/outputs, and relevant constraints
- Include interfaces, types, or contracts to define (by name, not file path)
- State how success is measured (what the check command verifies)
- Be specific enough that an agent can execute without further clarification
- Do NOT include specific file paths or function signatures — these go stale

**Omit** `dependsOn` entirely if empty. **Omit** `group` if none. Do not include `model`, `setup`, `check`, or `maxLoops` in per-task frontmatter unless they differ from `_defaults.yaml`.

### Writing files

Use the Write tool to create each file in sequence.

After writing all files, output:

```
Queue written to .knox/queues/<queue-name>/

Files:
  _defaults.yaml
  task-1.md
  task-2.md
  ...

To run:
  knox queue --name <queue-name>
```

---

## Guidelines

- **Task granularity**: Each task should be completable in one Knox run (10 loops or fewer). If a task seems too large, split it.
- **Groups**: Only group tasks that genuinely depend on each other's output and produce a coherent feature.
- **DAG validity**: Ensure no cycles. A task cannot directly or transitively depend on itself.
- **Naming**: Task IDs should be lowercase kebab-case verb-noun phrases (e.g., `define-auth-interface`, `implement-jwt-provider`, `write-auth-tests`).
- **Model**: Default to `sonnet`. Only suggest `opus` for tasks requiring unusually deep reasoning.
