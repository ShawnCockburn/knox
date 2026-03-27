---
name: knox-add-task
description: Add a single task file to an existing Knox queue directory. Use when user wants to add a task to a Knox queue, append a new task, or mentions "add task to queue".
---

Add a single task file to an existing Knox queue directory.

## Invocation

```
/knox-add-task "add rate limiting to the API"
/knox-add-task   # interactive mode — will prompt for description
```

---

## Step 1 — Get the task description

If the user provided a description as an argument, use it. Otherwise ask:
> What task do you want to add? Please describe it in one sentence.

---

## Step 2 — Explore the codebase

Before asking the user anything else, explore the project:

- List all directories under `.knox/queues/` — each is a queue
- If exactly one queue exists, select it automatically and tell the user
- If multiple queues exist, note them (you'll ask the user shortly)
- For the candidate queue(s), read all `.md` task files to extract:
  - Task ID (filename without `.md`)
  - `dependsOn` frontmatter field
  - `group` frontmatter field
  - One-line summary (first heading or first non-empty body line)
- Read `_defaults.yaml` to understand inherited model, setup, check, and maxLoops
- Build a mental model of the dependency graph and groups already in use

Use these findings to pre-fill suggestions for every question below.

---

## Step 3 — Interview (one question at a time)

Ask the following questions one at a time, proposing an answer based on the codebase before asking the user to confirm or correct.

**a) Queue** *(skip if only one queue exists)*
> Which queue should this task be added to?
> *Queues found: `<list>`*

**b) Dependencies**
> Should this task depend on any existing tasks?
> *Suggest based on the task description and the existing dependency graph.*
>
> Existing tasks:
> - `<id>`: <summary>
> - ...

**c) Group**
> Should this task belong to a group?
> *Suggest a group if the task clearly continues an existing logical feature chain.*
>
> Existing groups: `<list, or "none">`

**d) Overrides** *(only ask if the task seems to need non-default config)*
> Any overrides to the queue defaults?
> - model: (default: `<from _defaults.yaml>`)
> - maxLoops: (default: `<from _defaults.yaml>`)

---

## Step 4 — Validate dependencies

Before writing, verify the chosen dependencies:

- **Dangling references**: warn if any `dependsOn` ID does not exist in the queue:
  > Warning: `<id>` does not exist in this queue. Proceed anyway (it may be added later), or choose different dependencies?
- **No cycles**: a new task cannot form a cycle since nothing yet depends on it — but flag any impossible ordering the user may have implied.

---

## Step 5 — Generate the filename

Convert the task description to a kebab-case slug:
1. Lowercase
2. Replace non-alphanumeric characters with hyphens
3. Collapse multiple hyphens into one
4. Strip leading/trailing hyphens
5. Truncate to 60 characters at a word boundary

Example: `"Add rate limiting to the API"` → `add-rate-limiting-to-the-api`

**Conflict check**: if `<slug>.md` already exists, suggest an alternative:
> `add-rate-limiting-to-the-api.md` already exists. Use `add-rate-limiting-to-the-api-2.md`, or enter a different name?

---

## Step 6 — Write the task file

Create `.knox/queues/<queue-name>/<slug>.md`:

```markdown
---
dependsOn: [<id1>, <id2>]   # omit if empty
group: <group-name>          # omit if not set
model: <model>               # omit if not overriding
maxLoops: <number>           # omit if not overriding
---

# <Task description (title case)>

<Detailed task description — 2–5 sentences describing what behavior to implement,
key requirements, expected inputs/outputs, and relevant constraints. Be specific
enough that an agent can execute without further clarification.>
```

**Task description guidelines:**
- Describe *what behavior to implement*, not which files to touch — the agent discovers files itself
- Include interfaces, types, or contracts to define (by name, not file path)
- State how success is measured (what the check command verifies)
- Do NOT include specific file paths or function signatures — these go stale

**Frontmatter rules:**
- Omit `dependsOn` entirely if the list is empty (not `dependsOn: []`)
- Omit any override fields that are not set
- If no frontmatter fields are needed, omit the frontmatter block entirely

---

## Step 7 — Confirm and show the result

After writing the file, show the user:

1. The full path of the created file
2. The file contents
3. Where this task fits in the dependency graph:

```
Dependency graph (queue: <queue-name>):

  <id-a> ──► <id-b>
                └──► <new-task-id>  ← NEW
  <id-c> ──────────► <new-task-id>

  (standalone tasks: <id-d>, <id-e>)
```

If the new task has no dependencies and nothing depends on it:
> `<new-task-id>` is a standalone task (no dependencies).

If it belongs to a group, also show the group's linear chain:
```
Group "<group-name>":
  <first-id> → <second-id> → <new-task-id>  ← NEW
```

---

## Notes

- The filename (without `.md`) is the task ID referenced in `dependsOn` fields
- Queue directories live at `.knox/queues/<queue-name>/` relative to the project root
- The dependency graph must be acyclic (DAG) — cycles are rejected at queue load time
- Groups define linear chains — tasks in a group run sequentially on a shared branch
