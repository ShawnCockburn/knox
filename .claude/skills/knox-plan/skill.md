# knox-plan

Decompose a high-level goal into a Knox queue directory.

## Trigger

User invokes `/knox-plan` with a goal string, e.g.:
```
/knox-plan "refactor auth into interface + provider + tests"
```

The goal may be quoted or unquoted. Extract everything after `/knox-plan` as the goal.

---

## Phase 1 — Interview

Greet the user and ask clarifying questions before decomposing. Keep it concise — ask all questions in one message:

1. **Scope**: What files/modules are in scope? Are there files to avoid touching?
2. **Dependencies**: Are there any tasks that must happen strictly before others (e.g., types before implementations)?
3. **Grouping**: Should any tasks share a branch (stacked commits)? Related tasks that form a logical feature belong in the same group.
4. **Setup command**: Is there a setup command needed (e.g., `npm install`, `deno cache`)? This runs before all tasks.
5. **Check command**: Is there a verification command (e.g., `npm test`, `deno task check`)? This runs after each task to verify correctness.
6. **Max loops**: How many agent loop iterations per task? (default: 10)

Wait for the user's answers before proceeding to Phase 2.

---

## Phase 2 — Propose

Based on the goal and user answers, decompose into tasks. Present the decomposition clearly:

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
| ... | | | | |

**Dependency graph (DAG):**

```
task-1 ──► task-3 ──► task-5
task-2 ──► task-3
task-4 ──► task-5
```

Use ASCII art to show the dependency graph. Orphan tasks (no deps) appear on the left.

**Groups:**
- `group-name`: task-A → task-B → task-C (these produce stacked commits on one branch)
- Tasks without a group each get their own branch.

Then ask:
> Does this decomposition look right? Any tasks to add, remove, rename, or re-group? Reply "yes" to generate the queue, or describe your changes.

Wait for approval before proceeding to Phase 3.

---

## Phase 3 — Write Queue Directory

Once the user confirms (or after applying adjustments), generate the queue directory.

### Queue name derivation

Convert the goal to a kebab-case slug:
- Lowercase
- Replace spaces, slashes, underscores, and special characters with hyphens
- Remove repeated hyphens
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
  check: "npm test"       # omit if none
  maxLoops: 10
```

Only include `setup`, `check`, or `maxLoops` if they were specified (not defaults).
Always include `model: sonnet` and `concurrency`.

### Per-task `.md` file format

Each task file is named `<task-id>.md` and has YAML frontmatter followed by a detailed task description:

```markdown
---
id: task-id
dependsOn: [dep-1, dep-2]   # omit if no dependencies
group: group-name            # omit if no group
---

<Detailed task description here>

The description should include:
- What to implement or change
- Which files to create or modify
- Any interfaces, types, or contracts to define
- Any constraints or conventions to follow
- How success is measured (what the check command verifies)
```

**Important:** Omit `dependsOn` entirely if the array is empty. Omit `group` if the task has no group. Do not include `model`, `setup`, `check`, or `maxLoops` in per-task frontmatter unless they differ from `_defaults.yaml`.

### Writing files

Use the Write tool to create each file. Create the directory and all files in sequence.

After writing all files, output:

```
Queue written to .knox/queues/<queue-name>/

Files:
  _defaults.yaml
  task-1.md
  task-2.md
  ...

To run:
  knox queue --file .knox/queues/<queue-name>/<first-task>.md

Note: Knox currently uses `--file` with a single YAML manifest. To use this
directory-based format, either:
  1. Run tasks individually: knox run --task "$(cat .knox/queues/<queue-name>/<task>.md)"
  2. Combine into a YAML manifest manually
  3. Use `knox queue --name <queue-name>` if directory queue support is available
```

---

## Guidelines

- **Task granularity**: Each task should be completable in one Knox run (10 loops or fewer). If a task seems too large, split it.
- **Task descriptions**: Be specific. Include file paths, interfaces, function signatures where known. Vague tasks produce vague results.
- **Groups**: Only group tasks that genuinely depend on each other's output and produce a coherent feature. Don't group unrelated tasks.
- **DAG validity**: Ensure no cycles. A task cannot (directly or transitively) depend on itself.
- **Naming**: Task IDs should be lowercase kebab-case nouns or verb-noun phrases (e.g., `define-auth-interface`, `implement-jwt-provider`, `write-auth-tests`).
- **Model**: Default to `sonnet`. Only suggest `opus` for highly complex tasks that need deeper reasoning.
