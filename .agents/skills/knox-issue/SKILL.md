---
name: knox-issue
description: Create a GitHub Issue formatted for Knox's GitHub queue source. Use when user wants to create a Knox issue, file a task as a GitHub issue for Knox, or mentions "knox issue".
---

Create a GitHub Issue that Knox can pick up via `knox queue --source github`.

## Invocation

```
/knox-issue "refactor auth module to use JWT"
/knox-issue   # interactive mode — will prompt for description
```

---

## Step 1 — Get the task description

If the user provided a description as an argument, use it. Otherwise ask:

> What task should Knox work on? Describe it in one or two sentences.

---

## Step 2 — Explore the codebase

Before asking the user anything else, gather context:

- Read `.knox/config.yaml` to find `github.defaults` (model, features, prepare,
  check, maxLoops) and `github.authors`
- Skim the README, AGENTS.md, or CLAUDE.md for the project's standard
  build/test commands
- Check existing open issues labeled `agent/knox` via
  `gh issue list --label "agent/knox" --state open --limit 20` to avoid
  duplicates and understand existing task context

Use these findings to pre-fill suggestions for every question below.

---

## Step 3 — Interview (one question at a time)

Ask the following questions one at a time, proposing an answer based on what you
found. Skip questions where the defaults from `.knox/config.yaml` are
sufficient.

**a) Features**

> Does this task need specific language runtimes? _(Queue default:
> `<from config or "none">`. Available: python, node, deno, go, rust, ruby.)_

Skip if the config default covers the task's needs and tell the user you're
using the default.

**b) Prepare command**

> Is there a setup command needed beyond the queue default? _(Queue default:
> `<from config or "none">`)_

Skip if the config default is sufficient.

**c) Check command**

> What command verifies the task is done correctly? _(Queue default:
> `<from config or "none">`)_

Skip if the config default is sufficient.

**d) Model**

> Which model should Knox use? _(Queue default: `<from config or "sonnet">`. Use
> `opus` only for tasks requiring deep reasoning.)_

Skip if sonnet (or the config default) is appropriate.

**e) Max loops**

> How many agent loop iterations? _(Queue default: `<from config or "10">`)_

Skip if the default is appropriate.

---

## Step 4 — Build the issue body

The issue body uses YAML frontmatter followed by a Markdown task description —
the same format as directory-based Knox task files.

**Only include frontmatter fields that override the queue defaults.** If every
field matches the defaults, omit the frontmatter block entirely.

```markdown
---
model: opus # omit if using queue default
features: # omit if using queue default
  - python:3.12
prepare: "pip install -r requirements.txt" # omit if using queue default
check: "pytest" # omit if using queue default
maxLoops: 8 # omit if using queue default
---

<Detailed task description>
```

**Task description guidelines:**

- Describe _what behavior to implement_, not which files to touch — the agent
  discovers files itself
- Include the goal, key requirements, expected inputs/outputs, and relevant
  constraints
- Include interfaces, types, or contracts to define (by name, not file path)
- State how success is measured (what the check command verifies)
- Be specific enough that an agent can execute without further clarification
- Do NOT include specific file paths or function signatures — these go stale
- 3-8 sentences is typical; longer is fine for complex tasks

---

## Step 5 — Confirm with the user

Show the user the proposed issue before creating it:

> **Title:** `<concise imperative title>`
>
> **Label:** `agent/knox`
>
> **Body:**
>
> ```
> <full issue body with frontmatter + description>
> ```
>
> Create this issue? Reply "yes" to create, or describe changes.

Wait for approval before proceeding.

---

## Step 6 — Create the issue

Create the issue using the `gh` CLI:

```sh
gh issue create \
  --title "<title>" \
  --label "agent/knox" \
  --body "<body>"
```

If the `agent/knox` label does not exist yet, create it first:

```sh
gh label create "agent/knox" --description "Knox autonomous agent task" --color "6f42c1"
```

---

## Step 7 — Confirm

After creation, show the user:

1. The issue URL
2. How to run it:

```
To run all Knox issues:
  knox queue --source github

To run and output PRs:
  knox queue --source github --output pr
```

---

## Notes

- The `agent/knox` label is what Knox uses to discover issues — it is required
- Knox auto-creates `knox/claimed`, `knox/running`, `knox/failed`, and
  `knox/blocked` labels in the repo on first use for status tracking
- Knox never adds or removes the `agent/knox` label — that is yours to manage
- When a task completes, Knox closes the issue and removes `knox/claimed`
- Each issue gets an item ID like `gh-42-refactor-auth-to-jwt` (number + slug,
  slug capped at 50 chars)
- Pull requests with the `agent/knox` label are automatically filtered out
- Queue-level defaults come from `.knox/config.yaml` under `github.defaults` —
  only override in the issue body when needed
- If `github.authors` is set in config, only issues by those users are picked up
