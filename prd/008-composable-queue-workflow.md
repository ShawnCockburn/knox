# PRD 008: Composable Queue Workflow

## Problem Statement

Knox's queue system currently has a single input format (YAML manifest files)
and a single output format (git branches + JSON report). While functional, this
creates friction in two ways:

1. **Authoring friction** — YAML manifests are tedious to write by hand, not
   git-diff-friendly (all tasks buried in one file), and don't lend themselves
   to LLM-assisted generation. Developers want to define tasks as standalone,
   readable documents that any tool can create.

2. **Output friction** — Git branches are an intermediate artifact. Developers
   almost always want pull requests, not branches. The manual step of creating
   PRs from Knox branches — with correct base branches for dependent work — is
   error-prone and defeats the purpose of automation.

The queue pipeline (ingest → build → output) is implicit in the code but tightly
coupled. The input format, execution engine, and output strategy cannot be
varied independently.

## Solution

Evolve Knox's queue into a composable three-stage pipeline — **Ingest → Build →
Output** — where each stage is backed by a strategy interface and can be swapped
independently.

**Ingest**: Add a new `DirectoryQueueSource` that reads a directory of Markdown
task files (`.knox/queues/<queue-name>/`) alongside the existing YAML
`FileQueueSource`. Each `.md` file is a self-contained task definition with YAML
frontmatter for orchestration metadata and a Markdown body for the task
description. Queue-level defaults live in a `_defaults.yaml` file.

**Build**: Unchanged. The Knox engine is solid and stays as-is.

**Output**: Add a `QueueOutput` interface that runs after the orchestrator
completes. The first implementation, `PullRequestQueueOutput`, creates stacked
GitHub PRs with correct base branches, draft status for dependent PRs, and
explicit dependency callouts in PR descriptions. A `BranchQueueOutput` preserves
current behavior.

**Configuration**: Separate concerns cleanly. Queue definitions describe _what_
to build (tasks, deps, groups). Runner config (`.knox/config.yaml` + CLI flags)
describes _how_ to deliver results. This means the same queue can produce
branches in development and PRs in CI without changing the queue files.

**Authoring**: Two Claude Code skills — `knox plan` (decompose a goal into a
full queue directory) and `knox add-task` (add a single task to an existing
queue) — make it easy to create and extend queues with LLM assistance.

## User Stories

1. As a developer, I want to define each task as a separate Markdown file, so
   that I can read, diff, and review tasks individually in git.
2. As a developer, I want to create task files with any tool (editor, LLM,
   script), so that I'm not locked into hand-writing YAML.
3. As a developer, I want task file frontmatter to support all queue item fields
   (dependsOn, model, setup, check, group, maxLoops, env, cpu, memory), so that
   I have the same control as YAML manifests.
4. As a developer, I want the task ID derived from the filename, so that I don't
   have to keep an `id` field in sync with the file.
5. As a developer, I want a `_defaults.yaml` in my queue directory for shared
   config (concurrency, model, setup, check, env), so that I don't repeat config
   in every task file.
6. As a developer, I want to run `knox queue` with no arguments and have it
   discover all queues under `.knox/queues/`, so that I don't have to specify
   paths.
7. As a developer, I want `knox queue --name <name>` to run a specific queue, so
   that I can target one queue when I have multiple.
8. As a developer, I want multiple discovered queues to run sequentially with a
   combined report, so that I get a single summary across all queues.
9. As a developer, I want queue state persisted in a `.state.yaml` sidecar
   (gitignored) per queue directory, so that resume works and my task files stay
   immutable.
10. As a developer, I want `--resume` to work with directory queues the same way
    it works with YAML queues, so that I can retry failed items without
    re-running completed ones.
11. As a developer, I want Knox to create GitHub PRs from queue results, so that
    I don't have to manually create PRs from branches.
12. As a developer, I want independent tasks to produce individual PRs targeting
    `main`, so that each task's work is reviewable separately.
13. As a developer, I want grouped items to produce a single PR per group
    targeting `main`, so that related commits are reviewed together.
14. As a developer, I want items that depend on other items or groups to produce
    stacked PRs (targeting the dependency's branch as base), so that the diff
    only shows the item's own work.
15. As a developer, I want dependent PRs created as drafts, so that I know they
    can't be merged until their base PR merges.
16. As a developer, I want dependent PRs to include a clear callout in the
    description explaining the dependency chain and that GitHub will retarget
    the PR automatically after the base merges, so that reviewers understand the
    context.
17. As a developer, I want to configure the output strategy in
    `.knox/config.yaml` (e.g., `output: pr`), so that my project has a
    consistent default without passing CLI flags every time.
18. As a developer, I want CLI flags (e.g., `--output branch`) to override the
    project config, so that I can do dry runs or one-off overrides.
19. As a developer, I want `knox queue` to default to the project config's
    output strategy, so that teams can standardize on PR output.
20. As a developer, I want `knox run` (single task) to default to `branch`
    output even if the project config says `pr`, so that exploratory single runs
    don't create PRs unless I explicitly ask.
21. As a developer, I want `knox run --output pr` to create a PR for a single
    task, so that I can opt in when a single run should produce a PR.
22. As a developer, I want to use a `knox plan` skill to decompose a high-level
    goal into a full queue directory with correct dependencies and groups, so
    that I can go from idea to queue quickly.
23. As a developer, I want the `knox plan` skill to propose the dependency graph
    and ask for confirmation before writing files, so that I maintain control
    over the task structure.
24. As a developer, I want to use a `knox add-task` skill to add a single task
    to an existing queue directory, so that I can extend a queue incrementally.
25. As a developer, I want existing YAML manifests to continue working
    unchanged, so that this is purely additive.
26. As a developer, I want validation errors on Markdown task files (missing
    fields, broken dependsOn references, cycles) to be reported the same way as
    YAML validation errors, so that the feedback is consistent.
27. As a developer, I want PR labels configurable in `.knox/config.yaml`, so
    that Knox-created PRs are identifiable in my workflow.

## Implementation Decisions

### Module 1: MarkdownTaskParser

A pure function that takes a Markdown string and a filename, and returns a
`QueueItem`. Extracts YAML frontmatter (delimited by `---`), validates known
fields against the `QueueItem` schema, uses the Markdown body as the `task`
field, and derives `id` from the filename (stripping the `.md` extension).
Returns a result type with validation errors for unknown fields, missing
required body, or malformed frontmatter.

This module has no I/O and no dependencies on the filesystem.

### Module 2: DirectoryQueueSource

Implements the existing `QueueSource` interface (`load()`, `update()`). Given a
directory path:

- Globs for `*.md` files (excluding files starting with `_`)
- Calls `MarkdownTaskParser` for each file
- Reads `_defaults.yaml` if present, parses into `QueueDefaults`
- Assembles a `QueueManifest` from the parsed items and defaults
- Runs the result through the existing `validateManifest()` for structural,
  referential, and cycle validation
- Manages a `.state.yaml` sidecar in the same directory (same logic as
  `FileQueueSource`)

Also implements `readState()` and `writeState()` for resume support.

### Module 3: QueueOutput interface + implementations

A new interface invoked after the orchestrator completes:

```
interface QueueOutput {
  deliver(report: QueueReport, manifest: QueueManifest): Promise<QueueOutputResult>
}
```

**BranchQueueOutput**: No-op implementation. Returns the report as-is. This is
the current behavior.

**PullRequestQueueOutput**: Computes PRs from the report and manifest topology:

- Walks the manifest's dependency graph to determine the correct base branch for
  each PR
- Independent items (no group, no dependsOn): PR targets `main` (or the repo's
  default branch)
- Grouped items: one PR per group, targets `main`, branch is the group's shared
  branch
- Items with dependsOn pointing to another item/group: PR targets the
  dependency's result branch (stacked PR). Created as a draft with a dependency
  callout in the body.
- Uses `gh pr create` via shell for PR creation
- PR body includes: summary (from task description), dependency section (if
  stacked), test plan placeholder, Knox attribution line
- Skips PR creation for items that failed or were blocked

The orchestrator calls `QueueOutput.deliver()` after `run()` completes, before
returning the report to the CLI.

### Module 4: KnoxConfig

Reads `.knox/config.yaml` from the project root if it exists. Schema:

```yaml
output: pr | branch # default output strategy (default: branch)
pr:
  draft: true | false # create all PRs as draft (default: false for independent, true for dependent)
  labels: [string] # labels to apply to PRs
  reviewers: [string] # reviewers to request
```

Merges with CLI flags: CLI wins over config file. Provides a
`resolveOutputStrategy(command: "run" | "queue")` method that applies the
default-by-command logic (`run` defaults to `branch`, `queue` defaults to config
value).

### Module 5: Queue Discovery + Multi-Queue Runner

**Queue Discovery**: A function that scans `.knox/queues/` for subdirectories.
Each subdirectory that contains at least one `.md` file is a queue. Returns a
list of `{ name: string, path: string }`.

**Multi-Queue Runner**: Thin orchestration that:

- Discovers queues (or filters by `--name`)
- Runs each queue's orchestrator sequentially
- Collects per-queue reports into a combined report with queue names as keys
- Combined report JSON includes all queues' results
- Exit code: 0 if all items in all queues completed, 1 otherwise

### Module 6: Authoring Skills

**`knox plan` skill**: A Claude Code skill (not library code) that:

1. Takes a high-level goal as input
2. Interviews the user to clarify scope
3. Proposes a decomposition: task files with names, groups, dependencies
4. Presents the proposed DAG for user approval
5. On approval, writes `.knox/queues/<name>/` with `_defaults.yaml` and task
   `.md` files

**`knox add-task` skill**: A Claude Code skill that:

1. Takes a task description and optional queue name
2. If no queue name, lists existing queues for selection
3. Creates a single `.md` file in the target queue directory with appropriate
   frontmatter
4. If the task depends on existing tasks, sets `dependsOn` in frontmatter

### CLI Changes

- `knox queue` with no `--file` or `--name`: discovers and runs all queues under
  `.knox/queues/`
- `knox queue --name <name>`: runs a specific queue from `.knox/queues/<name>/`
- `knox queue --file <path>`: existing behavior, unchanged
- `knox queue --output <strategy>`: override output strategy
- `knox run --output <strategy>`: override output strategy for single runs
- Both commands load `.knox/config.yaml` for project-level defaults

### Directory Structure Convention

```
.knox/
├── config.yaml                # project-level runner config
├── queues/
│   ├── auth-refactor/
│   │   ├── _defaults.yaml     # concurrency, model, setup, check, env
│   │   ├── extract-interface.md
│   │   ├── implement-provider.md
│   │   ├── write-tests.md
│   │   └── .state.yaml        # runtime state (gitignored)
│   └── test-coverage/
│       ├── _defaults.yaml
│       ├── api-tests.md
│       └── .state.yaml
```

### Separation of Concerns

- **Queue definition** = what to build. Pure task descriptions and orchestration
  metadata. No output config.
- **Project config** (`.knox/config.yaml`) = how to deliver. Output strategy, PR
  options. Applies to all queues.
- **CLI flags** = per-invocation override. Highest precedence.

## Testing Decisions

### What Makes a Good Test

Tests should verify external behavior through the module's public interface, not
internal implementation details. Given an input, assert on the output. Mock
external dependencies (filesystem, `gh` CLI, Docker) but not internal
collaborators within a module. Tests should be independent — no shared mutable
state between test cases.

### Module 1: MarkdownTaskParser Tests

Test the pure parsing function with fixture strings. Prior art:
`validation_test.ts` pattern (input → result assertions).

- Valid task file with all frontmatter fields
- Valid task file with minimal frontmatter (just body)
- Missing body (empty Markdown content after frontmatter)
- Malformed frontmatter (not valid YAML)
- Unknown frontmatter fields (warning or error)
- Filename-to-ID derivation (stripping `.md`, handling special characters)
- Frontmatter with `dependsOn` as string vs array
- Body with complex Markdown (code blocks, headers, lists)

### Module 2: DirectoryQueueSource Tests

Test via the `QueueSource` interface with temp directories. Prior art:
`file_queue_source_test.ts` pattern (temp dir setup/teardown).

- Loads a directory with multiple `.md` files into a valid manifest
- Reads `_defaults.yaml` and merges into manifest defaults
- Works without `_defaults.yaml` (all defaults from frontmatter)
- Skips non-`.md` files and `_`-prefixed files
- Returns validation errors for broken `dependsOn` references
- State sidecar (`.state.yaml`) read/write/update
- Resume from existing state
- Empty directory (no `.md` files) returns error

### Module 3: QueueOutput Tests

Test PR computation logic with mock `gh` execution. Prior art:
`orchestrator_test.ts` pattern (mock engine factory).

- Independent items produce individual PRs targeting default branch
- Grouped items produce one PR per group targeting default branch
- Dependent items produce stacked PRs targeting dependency's branch
- Dependent PRs are created as drafts
- PR body includes dependency callout for stacked PRs
- Failed/blocked items produce no PRs
- Mixed queue (independent + grouped + dependent) computes all bases correctly
- `BranchQueueOutput` is a no-op (returns report unchanged)

### Module 4: KnoxConfig Tests

Test config loading and merging. Prior art: `file_queue_source_test.ts` pattern
(temp file fixtures).

- Loads valid `.knox/config.yaml`
- Returns defaults when no config file exists
- CLI flags override config file values
- `resolveOutputStrategy("run")` defaults to `branch`
- `resolveOutputStrategy("queue")` defaults to config value
- CLI `--output` overrides both defaults

### Module 5: Queue Discovery + Multi-Queue Runner Tests

Test discovery with temp directories. Test runner with mock orchestrator.

- Discovers all queue directories under `.knox/queues/`
- Ignores directories without `.md` files
- `--name` filters to specific queue
- Sequential execution of multiple queues
- Combined report includes all queues
- Exit code logic across multiple queues

### Module 6: Authoring Skills

Skills are Claude Code prompts, not library code. Testing is manual /
acceptance-based:

- `knox plan` generates valid task files that pass validation
- `knox add-task` creates a valid `.md` file with correct frontmatter
- Generated files load successfully via `DirectoryQueueSource`

## Out of Scope

- **Dynamic queue (push items to a running queue)**: Discussed and deferred. The
  orchestrator remains a static DAG runner.
- **Stdin/pipe input**: Considered and rejected for this iteration.
- **Removing or changing the existing YAML manifest input**: This is purely
  additive.
- **Changes to the Knox engine or agent loop**: The build layer is unchanged.
- **Remote/webhook output sinks** (Slack notifications, CI triggers): Future
  work. The `QueueOutput` interface enables these but they are not part of this
  PRD.
- **Cross-queue dependencies**: Each queue is an independent DAG. Items cannot
  depend on items in other queues.
- **PR merge automation**: Knox creates PRs but does not merge them. Merge order
  is the developer's responsibility.
- **Single-task `knox run` changes beyond output strategy**: The `knox run`
  command only gains `--output` flag support; no other changes.

## Further Notes

- The `QueueSource` interface already exists in the codebase
  (`src/queue/types.ts:78-84`). `DirectoryQueueSource` is a new implementation
  of this existing interface — no interface changes needed.
- The existing `validateManifest()` function is reused by `DirectoryQueueSource`
  after assembling the manifest from parsed Markdown files. No changes to
  validation logic.
- The `.state.yaml` sidecar pattern is proven in `FileQueueSource` and carries
  over directly. State files should be added to `.gitignore`.
- PR creation depends on the `gh` CLI being installed and authenticated.
  `PullRequestQueueOutput` should check for `gh` availability and fail fast with
  a clear error if not present.
- The `_defaults.yaml` file uses the same schema as the existing `QueueDefaults`
  type. No new types needed for defaults.
- The Markdown frontmatter parser should use a standard YAML parser (already
  available via `@std/yaml`) with `---` delimiters. No need for a custom parser
  — split on `---`, parse the YAML block, treat the rest as task body.
