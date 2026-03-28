# Plan: GitHub Issues Queue Source

> Source PRD: prd/010-github-issues-queue-source.md

## Architectural decisions

Durable decisions that apply across all phases:

- **Interface contract**: `GitHubIssueQueueSource` implements existing
  `QueueSource` (`load() → LoadResult`, `update(itemId, state)`)
- **GitHub interaction layer**: All `gh` CLI calls go through a `GitHubClient`
  module that accepts a `CommandRunner` for testability, matching the pattern
  established by `PullRequestQueueOutput`
- **Config shape**: `github` section in `.knox/config.yaml` with
  `authors: string[]` and `defaults: QueueDefaults`
- **Item ID format**: `gh-<number>-<slugified-title>` with 50-character title
  portion cap. Slugification: lowercase, non-alphanumeric → hyphens, collapse
  consecutive hyphens, trim trailing hyphens
- **Label taxonomy**: `agent/knox` is user-managed (Knox never touches it).
  `knox/claimed`, `knox/running`, `knox/failed`, `knox/blocked` are Knox-managed
  and auto-created on first use
- **Claim identity**: The existing `queueRunId` is used as the claim identifier,
  embedded in issue comments as `knox-claim:<runId>`
- **State model**: Dual-write to local `.state.yaml` (for orchestrator
  compatibility) and remote GitHub (labels + comments, for visibility and
  coordination). On resume, hard stop if local and remote state diverge
- **CLI contract**: `--source` is a required flag on `knox queue`, accepting
  `directory` or `github`. This is a breaking change from implicit directory
  auto-detection
- **Error classification**: API failures are split into critical (claim
  protocol, closing issues — cause skip/abort) and cosmetic (running label,
  progress comments — warn and continue)

---

## Phase 1: Single issue end-to-end

**User stories**: 1, 2, 4, 15, 21, 22, 23, 24, 25, 27, 28

### What to build

The thinnest possible vertical slice: a user creates a GitHub Issue with the
`agent/knox` label and optional YAML frontmatter in the body, runs
`knox queue --source github`, and Knox fetches the issue, parses it into a
`QueueItem`, executes it through the existing orchestrator, creates a branch (or
PR), and closes the issue.

This phase introduces the `--source` flag as required on `knox queue` (breaking
change). `--source directory` preserves all existing behavior. `--source github`
wires up the new `GitHubIssueQueueSource`.

The `GitHubClient` module wraps `gh` CLI calls with a `CommandRunner` injection
point. The `IssueMapper` converts a GitHub issue into a `QueueItem` by parsing
the body with the existing Markdown task parser. Item IDs follow the
`gh-<number>-<slug>` format.

The `github` config section is added to `.knox/config.yaml` for queue-level
defaults (model, features, etc.). `knox/*` labels are auto-created if missing.

No claiming, no dependencies, no resume, no author filtering — just prove the
full path works for one issue with no contention.

### Acceptance criteria

- [ ] `knox queue` without `--source` prints an error with migration
      instructions
- [ ] `knox queue --source directory` works identically to current behavior
      (with `--file`, `--name`, and discovery modes)
- [ ] `knox queue --source github` fetches open issues with `agent/knox` label
      from the current repo
- [ ] Issue body with YAML frontmatter (model, features, maxLoops, etc.) is
      parsed into a `QueueItem` using existing Markdown task parser conventions
- [ ] Item ID is generated as `gh-<number>-<slugified-title>` with 50-char title
      cap
- [ ] Queue-level defaults from `.knox/config.yaml` `github.defaults` are
      applied to items missing those fields
- [ ] Orchestrator runs the item and produces a branch via the existing sink
      pipeline
- [ ] On completion, the issue is closed and `knox/claimed` label is removed
- [ ] `knox/*` labels are auto-created in the repo if they don't already exist
- [ ] Knox never adds or removes the `agent/knox` label
- [ ] `GitHubClient` accepts a `CommandRunner` and all tests use a mock runner

---

## Phase 2: Dependencies + filtering

**User stories**: 3, 13, 14, 16, 17, 26

### What to build

Add dependency resolution across GitHub Issues and filtering controls so that
the source produces a valid DAG and only ingests appropriate issues.

`dependsOn` values in issue frontmatter use GitHub's `#N` syntax (e.g.,
`dependsOn: ["#37", "#41"]`). The source normalizes these to internal item IDs
(`gh-37-<slug>`, `gh-41-<slug>`) when building the manifest. The existing
validation pipeline (referential integrity, cycle detection) runs on the
resulting graph — no new validation logic needed.

Author filtering is added: the `github.authors` config field accepts a list of
GitHub usernames. When empty or omitted, it defaults to the current `gh` user
(resolved via `gh api user` at load time). Only issues created by listed authors
are ingested. Pull requests are filtered out (GitHub's issue API includes PRs).
A warning is emitted if more than 100 issues match the initial query.

A preflight check validates `gh auth status` before any other API calls, failing
fast with a clear message if auth is missing or expired.

### Acceptance criteria

- [ ] `dependsOn: ["#37"]` in issue frontmatter is normalized to the internal ID
      of issue #37
- [ ] Dependency graph validation (referential integrity, cycle detection) works
      across GitHub Issues
- [ ] Items with unmet dependencies are held until dependencies complete,
      matching existing orchestrator behavior
- [ ] Issues not created by an author in the `github.authors` list are excluded
      from the manifest
- [ ] When `github.authors` is empty or omitted, only issues by the current `gh`
      user are ingested
- [ ] Pull requests tagged with `agent/knox` are excluded from the manifest
- [ ] A warning is logged when more than 100 issues match the query
- [ ] `gh auth status` is checked before any other API calls; failure produces a
      clear error and exits

---

## Phase 3: Claim protocol

**User stories**: 8, 9, 10

### What to build

The distributed coordination protocol that prevents multiple Knox instances from
working on the same issue. After loading and filtering, the source claims all
eligible issues before execution begins.

For each eligible issue (no existing `knox/claimed` label, dependencies
satisfiable): post a comment containing `knox-claim:<queueRunId>`, add the
`knox/claimed` label, wait a random 1-3 seconds, then re-fetch the issue
timeline. If this run's claim comment is the first claim comment in the
timeline, the claim is won. If another run's claim appeared first, this run lost
— remove the comment, remove the label, and skip the issue.

Claims are released on all terminal states: completion (issue closed, label
removed), failure (label removed), blocked (label removed), and abort/cleanup
(all remaining claims released). The manifest passed to the orchestrator
contains only successfully claimed issues.

### Acceptance criteria

- [ ] Each eligible issue receives a `knox-claim:<queueRunId>` comment and
      `knox/claimed` label
- [ ] A random delay between 1 and 3 seconds occurs before timeline verification
- [ ] The first claim comment in the issue timeline wins; losing claims are
      cleaned up (comment removed, label removed)
- [ ] Only successfully claimed issues are included in the manifest passed to
      the orchestrator
- [ ] Claims are released when an item completes, fails, or is blocked
- [ ] All remaining claims are released on run abort or cleanup (SIGINT,
      unhandled error)
- [ ] Two simulated Knox instances claiming the same issue results in exactly
      one winner and one clean loser

---

## Phase 4: Lifecycle labels + comments

**User stories**: 5, 6, 7

### What to build

Full issue lifecycle feedback via labels and comments so that stakeholders can
track progress directly on GitHub without access to Knox logs.

When an item starts executing, the `knox/running` label is added. When it
finishes, `knox/running` is removed. On completion, a comment is posted with the
branch name (and PR link if output is `pr`) and execution duration. On failure,
a `knox/failed` label is added and a comment is posted with an error summary and
pointer to where full logs can be found. On block, a `knox/blocked` label is
added and a comment notes which issue caused the block (e.g., "Blocked by #37").

Label and comment updates during execution follow the critical/cosmetic error
split: failure to add `knox/running` is a warning (cosmetic), failure to close
an issue or add `knox/failed` causes the item to be marked as failed locally
(critical).

### Acceptance criteria

- [ ] `knox/running` label is added when execution starts and removed when
      execution ends
- [ ] Completion comment includes branch name (or PR link) and duration
- [ ] Failure comment includes error summary and log location
- [ ] `knox/failed` label is added on failure and removed on retry
- [ ] Blocked comment references the blocking issue number
- [ ] `knox/blocked` label is added on block and removed on retry
- [ ] Cosmetic label failures (e.g., `knox/running`) log a warning and do not
      fail the item
- [ ] Critical update failures (e.g., closing issue, adding `knox/failed`) cause
      the item to fail locally

---

## Phase 5: State dual-write + resume reconciliation

**User stories**: 11, 12

### What to build

State persistence that keeps local and remote in sync, and a resume path that
detects when they've diverged.

Every `QueueSource.update()` call writes to both the local `.state.yaml` file
and the corresponding GitHub issue (label changes, comments). This is the
dual-write mechanism — local state is authoritative for the orchestrator, remote
state is authoritative for visibility and cross-instance coordination.

On `--resume`, the source re-fetches all `agent/knox` issues and compares each
item's local state against remote state. Checked fields: item status (local
status vs issue open/closed and label state), issue title, and issue
body/description. If any item has a mismatch, the source logs every discrepancy
in a structured format and exits with a recommendation to run without
`--resume`.

No partial reconciliation — any mismatch is a hard stop. This keeps the mental
model simple: resume is only safe when nothing has changed externally.

### Acceptance criteria

- [ ] Every `update()` call persists state to both local `.state.yaml` and
      GitHub (labels/comments)
- [ ] `--resume` loads existing local state and re-fetches all issues from
      GitHub
- [ ] Status mismatch (e.g., locally completed but issue still open) is detected
      and reported
- [ ] Title change since last run is detected and reported
- [ ] Description/body change since last run is detected and reported
- [ ] All discrepancies are logged in a single structured message listing every
      mismatched item
- [ ] The error message recommends running without `--resume`
- [ ] When local and remote state are fully aligned, resume proceeds normally
      (retries failed/blocked, skips completed)

---

## Phase 6: Output integration + groups

**User stories**: 18, 19, 20

### What to build

Wire GitHub Issue metadata into the PR output stage and enable group support for
stacked commits.

When the output strategy is `pr` and the source is GitHub Issues, the PR body
includes `Closes #N` (using the issue number) so that merging the PR auto-closes
the source issue. For grouped issues (multiple issues sharing a `group` value in
frontmatter), all issues in the group share a single branch with stacked
commits, and the PR body includes `Closes #N` for every issue in the group.

Group support works identically to directory-based queues: items in the same
group form a linear chain, each item sees the previous item's commits, and the
orchestrator enforces sequential execution within the group. The only new
behavior is the `Closes` keywords in the PR body.

### Acceptance criteria

- [ ] PRs created from GitHub Issue tasks include `Closes #N` in the body
- [ ] Merging the PR auto-closes the corresponding issue on GitHub
- [ ] Issues with `group` frontmatter field produce stacked commits on a shared
      branch
- [ ] Group validation (linear chain, no diamonds) works for GitHub Issues
- [ ] PR for a grouped set of issues includes `Closes #N` for every issue in the
      group
- [ ] Items within a group execute sequentially and each sees the previous
      item's changes
- [ ] Non-grouped issues each produce their own independent branch/PR
