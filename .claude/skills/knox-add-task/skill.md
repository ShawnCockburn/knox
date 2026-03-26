# knox-add-task

Add a single task file to an existing Knox queue directory.

## Usage

```
/knox-add-task "add rate limiting to the API"
/knox-add-task   # interactive mode — will prompt for description
```

## Instructions

When this skill is invoked, follow these steps in order:

### Step 1: Get the task description

If the user provided a task description as an argument (e.g., `/knox-add-task "add rate limiting"`), use that. Otherwise, ask:
> What task do you want to add? Please describe it in one sentence.

### Step 2: Discover queues

List the directories under `.knox/queues/`. Each subdirectory is a queue.

- **No queues found**: Tell the user no queues exist yet and offer to create a new one by asking for a queue name. If they confirm, create the directory `.knox/queues/<name>/`.
- **Exactly one queue**: Use it automatically. Tell the user which queue you're using.
- **Multiple queues**: Ask the user which queue to add the task to (show the list).

### Step 3: Read existing tasks in the target queue

Read all `.md` files in the chosen queue directory. For each file, extract:
- The filename (without `.md`) — this is the task ID
- The `dependsOn` frontmatter field (list of task IDs this task depends on)
- The `group` frontmatter field (if any)
- A one-line summary: either the first heading or the first non-empty line of the body

Build a mental model of:
- The **dependency graph** (which tasks depend on which)
- The **groups** in use (unique values of `group` across all tasks)

If the queue is empty, note that there are no existing tasks.

### Step 4: Ask the user authoring questions

Present the existing tasks clearly (ID and summary), then ask:

**a) Dependencies**
> Should this task depend on any existing tasks? (Enter task IDs separated by commas, or press Enter for none)
>
> Existing tasks:
> - `<id>`: <summary>
> - ...

**b) Group**
> Should this task belong to a group?
>
> Existing groups: <list, or "none">
> Enter a group name to join an existing group or create a new one, or press Enter for no group.

**c) Overrides** (optional, ask only if user seems to want customization)
> Any overrides? (optional — press Enter to skip each)
> - model: (default: inherited from queue)
> - setup: (default: inherited)
> - check: (default: inherited)
> - maxLoops: (default: inherited)

### Step 5: Validate dependencies (cycle detection)

Before writing, verify the chosen dependencies are valid.

**Cycle detection:**
Since this is a brand-new task (not yet referenced by anything), it cannot form a cycle as a target. However:
- Warn if any chosen `dependsOn` IDs do not exist in the queue (dangling references):
  > Warning: task ID `<id>` does not exist in this queue. Would you like to proceed anyway (it may be added later), or choose different dependencies?
- If the user specifies deps that would form a cycle among themselves (possible only if they also specify group membership that implies ordering), flag it and ask for correction.

### Step 6: Generate the filename

Convert the task description to a kebab-case slug:
1. Lowercase the description
2. Replace non-alphanumeric characters with hyphens
3. Collapse multiple hyphens into one
4. Strip leading/trailing hyphens
5. Truncate to 60 characters at a word boundary if needed

Example: `"Add rate limiting to the API"` → `add-rate-limiting-to-the-api`

**Conflict check**: If `<slug>.md` already exists in the queue directory, suggest an alternative:
> A file named `add-rate-limiting-to-the-api.md` already exists. Would you like to use `add-rate-limiting-to-the-api-2.md` instead, or enter a different name?

### Step 7: Write the task file

Create `.knox/queues/<queue-name>/<slug>.md` with this structure:

```markdown
---
dependsOn: [<id1>, <id2>]   # omit if empty
group: <group-name>          # omit if not set
model: <model>               # omit if not overriding
setup: <setup-command>       # omit if not overriding
check: <check-command>       # omit if not overriding
maxLoops: <number>           # omit if not overriding
---

# <Task description (title case)>

<Detailed task description — 2-5 sentences expanding on the task, describing
what needs to be built, key requirements, expected inputs/outputs, and any
relevant context from the codebase. Be specific enough that an AI agent can
execute the task without additional clarification.>
```

**Rules for frontmatter:**
- Omit `dependsOn` entirely if the list is empty (not `dependsOn: []`)
- Omit any override fields that are not set
- If no frontmatter fields are needed, omit the frontmatter block entirely

### Step 8: Confirm and show the result

After writing the file, show the user:

1. The full path of the created file
2. The file contents
3. A text representation of where this task fits in the dependency graph:

```
Dependency graph (queue: <queue-name>):

  <id-a> ──► <id-b>
                └──► <new-task-id>  ← NEW
  <id-c> ──────────► <new-task-id>

  (standalone tasks: <id-d>, <id-e>)
```

If the new task has no dependencies and nothing depends on it, say:
> `<new-task-id>` is a standalone task (no dependencies).

If the task belongs to a group, also show the group's linear chain:
```
Group "<group-name>":
  <first-id> → <second-id> → <new-task-id>  ← NEW
```

## Notes

- Task files use YAML frontmatter (between `---` delimiters) followed by a Markdown body.
- The filename (without `.md`) serves as the task ID referenced in `dependsOn` fields.
- Queue directories live at `.knox/queues/<queue-name>/` relative to the project root.
- The dependency graph must be acyclic (DAG). Cycles are rejected at queue load time.
- Groups define linear chains — items in a group run sequentially on a shared branch.
