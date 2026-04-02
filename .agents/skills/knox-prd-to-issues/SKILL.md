---
name: knox-prd-to-issues
description: Break a PRD into Knox-formatted GitHub issues using tracer-bullet vertical slices. Use when user wants to convert a PRD to Knox issues, create Knox implementation tickets from a PRD, or break down a PRD into Knox work items.
---

Break a PRD into independently-grabbable GitHub issues formatted for Knox's
GitHub queue source, using vertical slices (tracer bullets).

## Invocation

```
/knox-prd-to-issues ./prd/008-composable-queue-workflow.md
/knox-prd-to-issues 42          # GitHub issue number containing a PRD
/knox-prd-to-issues             # interactive mode — will prompt for PRD location
```

The argument may be:

- A **local file path** — read the PRD from the local filesystem
- A **GitHub issue number** (or URL) — fetch the PRD with `gh issue view`
- **Omitted** — ask the user where the PRD lives

---

## Step 1 — Locate the PRD

If the user provided an argument, determine its type:

- If it looks like a file path (contains `/` or `.md`), read it with the Read
  tool
- If it looks like a number or GitHub URL, fetch it with
  `gh issue view <number>` (include comments)
- Otherwise, ask:

> Where is the PRD? Provide a local file path (e.g., `./prd/011-feature.md`)
> or a GitHub issue number.

---

## Step 2 — Explore the codebase

Before asking the user anything else, gather context:

- Read `.knox/config.yaml` to find `github.defaults` (model, features, prepare,
  check, maxLoops) and `github.authors`
- Read the `README.md`, `AGENTS.md`, or `CLAUDE.md` for the project's standard
  build/test commands
- Check existing open issues labeled `agent/knox` via
  `gh issue list --label "agent/knox" --state open --limit 20` to avoid
  duplicates and understand existing task context
- If any `_defaults.yaml` files exist under `.knox/queues/`, read them to
  understand current conventions

Use these findings to pre-fill sensible defaults so you ask fewer questions.

---

## Step 3 — Interview for queue-level config

Ask the following questions **one at a time**, proposing an answer based on what
you found. Skip questions where the defaults from `.knox/config.yaml` are
sufficient.

**a) Features**

> Do these tasks need specific language runtimes?
> _(Queue default: `<from config or "none">`. Available: python, node, deno, go,
> rust, ruby.)_

Skip if the config default covers the PRD's needs and tell the user you're
using the default.

**b) Prepare command**

> Is there a setup command needed beyond the queue default?
> _(Queue default: `<from config or "none">`)_

Skip if the config default is sufficient.

**c) Check command**

> What command verifies tasks are done correctly?
> _(Queue default: `<from config or "none">`)_

Skip if the config default is sufficient.

**d) Model**

> Which model should Knox use for these tasks?
> _(Queue default: `<from config or "sonnet">`. Use `opus` only for tasks
> requiring deep reasoning.)_

Skip if sonnet (or the config default) is appropriate.

**e) Max loops**

> How many agent loop iterations? _(Queue default: `<from config or "10">`)_

Skip if the default is appropriate.

---

## Step 4 — Draft vertical slices

Break the PRD into **tracer bullet** issues. Each issue is a thin vertical
slice that cuts through ALL integration layers end-to-end, NOT a horizontal
slice of one layer.

Slices must be typed as **HITL** or **AFK**:

- **AFK** — can be implemented and merged by Knox without human interaction
- **HITL** — requires a human decision, design review, or manual verification

Prefer AFK over HITL where possible.

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer (schema,
  API, CLI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
- Each slice should be completable in one Knox run (10 loops or fewer) — if a
  slice seems too large, split it
- Only group slices that genuinely depend on each other's output
</vertical-slice-rules>

Present the proposed breakdown as a numbered table:

### Proposed breakdown

| #  | Task ID           | Type | Blocked by | Description                |
| -- | ----------------- | ---- | ---------- | -------------------------- |
| 1  | `define-auth-ifc` | AFK  | —          | Define auth interface type |
| 2  | `impl-jwt`        | AFK  | 1          | Implement JWT provider     |

**Dependency graph (DAG):**

```
define-auth-ifc ──► impl-jwt ──► write-auth-tests
```

Then ask:

> Does this decomposition look right?
>
> - Is the granularity right? (too coarse / too fine)
> - Are the dependency relationships correct?
> - Should any slices be merged or split further?
> - Are the HITL / AFK designations correct?
> - Any config overrides needed for specific tasks?
>
> Reply "yes" to proceed, or describe your changes.

Iterate until the user approves the breakdown.

---

## Step 5 — Build the issue bodies

For each approved slice, build an issue body using YAML frontmatter followed by
a Markdown task description — the same format as directory-based Knox task files
and single Knox issues.

**Only include frontmatter fields that override the queue defaults** confirmed
in Step 3. If every field matches the defaults, omit the frontmatter block
entirely.

```markdown
---
features:
  - deno
prepare: deno install
check: "deno task check && deno task test:unit"
dependsOn: ["#10", "#12"]
---

## Parent PRD

<link to PRD file or issue>

## What to build

<Concise description of this vertical slice. Describe the end-to-end behavior,
not layer-by-layer implementation. Reference specific sections of the parent PRD
rather than duplicating content.>

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

- Blocked by #10 (short description)
- Blocked by #12 (short description)

Or "None - can start immediately" if no blockers.
```

**Frontmatter rules:**

- Only include frontmatter fields that override the queue defaults from
  `.knox/config.yaml`. If every field matches the defaults, omit the frontmatter
  block entirely.
- `dependsOn`: quoted `"#N"` format inside a YAML array — e.g.,
  `dependsOn: ["#10"]` or `dependsOn: ["#10", "#12"]`. Always quote the
  items because `#` starts a YAML comment when unquoted.
- All fields (`features`, `prepare`, `check`, `model`, `maxLoops`,
  `dependsOn`) are optional — only include what the task needs.

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

## Step 6 — Confirm with the user

Show the user ALL proposed issues before creating any of them:

> **Issue 1 of N**
>
> **Title:** `<concise imperative title>`
> **Label:** `agent/knox`
> **Type:** AFK
>
> **Body:**
>
> ```
> <full issue body with frontmatter + description>
> ```
>
> ---
>
> **Issue 2 of N**
> ...

Then ask:

> Create all N issues? Reply "yes" to create, or describe changes.

Wait for approval before proceeding.

---

## Step 7 — Create the issues

Create issues in **dependency order** (blockers first) so you can reference
real issue numbers in the "Blocked by" field.

If the `agent/knox` label does not exist yet, create it first:

```sh
gh label create "agent/knox" --description "Knox autonomous agent task" --color "6f42c1"
```

For each issue:

```sh
gh issue create \
  --title "<title>" \
  --label "agent/knox" \
  --body "<body>"
```

After creating each issue, capture its number so subsequent issues can reference
it in their "Blocked by" section.

**HITL issues** should also get a `knox/blocked` label so Knox skips them until
a human unblocks:

```sh
gh issue create \
  --title "<title>" \
  --label "agent/knox" \
  --label "knox/blocked" \
  --body "<body>"
```

---

## Step 8 — Summary

After all issues are created, show a summary table:

| #  | Issue  | Title                   | Type | Blocked by |
| -- | ------ | ----------------------- | ---- | ---------- |
| 1  | #101   | Define auth interface   | AFK  | —          |
| 2  | #102   | Implement JWT provider  | AFK  | #101       |

Then show how to run:

```
To run all Knox issues:
  knox queue --source github

To run and output PRs:
  knox queue --source github --output pr
```

Do NOT close or modify the parent PRD issue (if it was a GitHub issue).

---

## Notes

- The `agent/knox` label is what Knox uses to discover issues — it is required
- Knox auto-creates `knox/claimed`, `knox/running`, `knox/failed`, and
  `knox/blocked` labels in the repo on first use for status tracking
- Knox never adds or removes the `agent/knox` label — that is yours to manage
- When a task completes, Knox closes the issue and removes `knox/claimed`
- Pull requests with the `agent/knox` label are automatically filtered out
- Queue-level defaults come from `.knox/config.yaml` under `github.defaults` —
  only override in the issue body when needed
- If `github.authors` is set in config, only issues by those users are picked up
- Each issue gets an item ID like `gh-42-refactor-auth-to-jwt` (number + slug,
  slug capped at 50 chars)
- HITL issues are created with `knox/blocked` so Knox won't pick them up until
  a human removes the label — this replaces the need for manual triage
