# PRD 010: GitHub Issues Queue Source

## Problem Statement

Knox queues are currently defined locally — either as YAML files or directories of Markdown task files. This works well for a single developer authoring tasks on their machine, but it doesn't support a collaborative workflow where multiple stakeholders (product managers, tech leads, other developers) can create and prioritize work that Knox picks up automatically.

Teams want to use GitHub Issues as a work intake mechanism: file an issue, tag it, and have Knox claim it, execute it, and deliver the result as a branch or PR — without anyone manually writing queue files. This introduces two hard problems that local queues don't face:

1. **Distributed coordination.** Multiple Knox instances may poll the same repo simultaneously. Without a coordination protocol, two instances can claim the same issue, wasting compute and producing conflicting branches.
2. **State lives in two places.** Local queue state (the `.state.yaml` file) and remote state (issue labels, open/closed status) can diverge — especially across resume boundaries — leading to stale or contradictory views of what's been done.

## Solution

Add a new `GitHubIssueQueueSource` that implements the existing `QueueSource` interface, allowing the orchestrator to treat GitHub Issues as a task source with no changes to the scheduling, execution, or output pipeline.

The source fetches all open issues with the `agent/knox` label, parses their bodies using the same Markdown frontmatter format Knox already uses for directory-based tasks, builds a `QueueManifest` with dependency graph, and claims eligible issues using a distributed claim-then-verify protocol before execution begins.

State is dual-written: locally to a `.state.yaml` file (for orchestrator compatibility and resume) and remotely to GitHub (labels and comments, for visibility and coordination). On resume, the source reconciles local and remote state and hard-stops on any mismatch.

The `knox queue` command gains a required `--source` flag (`directory` or `github`), replacing the current implicit directory-based behavior.

## User Stories

1. As a team member, I want to file a GitHub Issue with the `agent/knox` label so that Knox automatically picks it up and executes it without anyone writing a queue file.
2. As a team member, I want to include YAML frontmatter in my issue body (model, features, dependsOn, etc.) so that I can configure the task environment the same way I would in a Markdown task file.
3. As a team member, I want to express dependencies between issues using GitHub's `#N` syntax in frontmatter (`dependsOn: ["#37"]`) so that Knox respects execution ordering.
4. As a team member, I want Knox to close my issue automatically when the task completes so that I don't have to manually track which issues are done.
5. As a team member, I want Knox to post a completion comment with the branch name, PR link, and duration so that I can find the output without digging through logs.
6. As a team member, I want Knox to add a `knox/failed` label and post an error summary when a task fails so that I can see what went wrong directly on the issue.
7. As a team member, I want Knox to add a `knox/blocked` label and comment noting the blocking issue when a task is blocked so that dependency failures are visible.
8. As a Knox operator running multiple instances, I want only one instance to claim and execute a given issue so that compute isn't wasted on duplicate work.
9. As a Knox operator, I want the claim protocol to resolve races without an external lock service so that I don't need additional infrastructure.
10. As a Knox operator, I want all claims released on run completion, failure, or abort so that issues are available for retry on the next run.
11. As a Knox operator, I want a clear error with all discrepancies listed when I resume and local/remote state have diverged so that I understand what changed and can decide how to proceed.
12. As a Knox operator, I want state divergence detected for status mismatches, title changes, and description changes so that I'm never working from a stale view of the issue.
13. As a Knox operator, I want a warning when more than 100 issues match the query so that I know my filter might be too broad.
14. As a Knox operator, I want Knox to validate `gh auth status` before starting so that I get a clear auth error upfront rather than mid-execution.
15. As a queue author, I want to configure default task settings (model, features, maxLoops, etc.) in `.knox/config.yaml` under a `github` section so that I don't repeat configuration in every issue.
16. As a queue author, I want to restrict which GitHub users' issues are ingested via an `authors` list so that not every `agent/knox`-tagged issue in the repo triggers execution.
17. As a queue author, I want the `authors` list to default to the current `gh` user when empty or omitted so that single-user setups are safe by default.
18. As a queue author, I want to use the `group` frontmatter field on issues so that related issues produce stacked commits on a shared branch, just like directory-based queues.
19. As a queue author, I want PRs created from GitHub Issue tasks to include `Closes #N` in the body so that merging the PR auto-closes the source issue.
20. As a queue author with grouped issues, I want the PR body to include multiple `Closes #N` keywords so that all issues in the group are closed on merge.
21. As a Knox user, I want `knox queue --source github` to invoke the GitHub Issues source so that I have an explicit, unambiguous command.
22. As a Knox user, I want `--source` to be a required flag so that there is no implicit behavior to misunderstand.
23. As a Knox user, I want existing directory-based queues to work via `knox queue --source directory` so that the breaking change has a clear migration path.
24. As a Knox user, I want Knox to auto-create `knox/*` labels (claimed, running, failed, blocked) if they don't exist so that I don't have to set up labels manually.
25. As a Knox user, I want Knox to never add or remove the `agent/knox` label so that I retain full control over which issues are eligible.
26. As a Knox user, I want pull requests filtered out of the issue list so that PRs accidentally tagged `agent/knox` don't get treated as tasks.
27. As a Knox user, I want each issue's item ID to be `gh-<number>-<slugified-title>` so that logs, state files, and branch names are human-readable and traceable.
28. As a Knox user, I want the slugified title portion capped at 50 characters so that branch names stay within practical limits.

## Implementation Decisions

### Modules to build

**GitHubIssueQueueSource** — New module implementing `QueueSource`. Responsible for: fetching issues via `gh` CLI, filtering by label/author/PR-exclusion, converting issues to `QueueManifest`, dual-writing state to local file and GitHub, and reconciling state on resume. Constructor takes repo (derived from git remote) and config as parameters.

**GitHubClient** — New module wrapping `gh` CLI interactions (list issues, add/remove labels, post comments, fetch timeline, close issues, auth status check). Accepts a `CommandRunner` function for testability, matching the pattern established by `PullRequestQueueOutput`. All GitHub API interactions are centralized here.

**ClaimProtocol** — New module encapsulating the claim-then-verify logic. Takes a `GitHubClient` and `queueRunId`. For each eligible issue: posts a `knox-claim:<runId>` comment, adds `knox/claimed` label, waits 1-3 seconds (random), re-fetches the issue timeline, checks if its claim comment is first. Returns claimed/lost result. Also handles claim release (remove label, optionally remove comment).

**IssueMapper** — Logic to convert a GitHub issue into a `QueueItem`. Reuses `parseMarkdownTask` for the body (frontmatter + task text). Generates item ID as `gh-<number>-<slugified-title>` with 50-char title cap. Normalizes `dependsOn` values from `#N` format to `gh-<N>-<slug>` internal IDs.

**StateReconciler** — On resume, compares each item's local state against remote GitHub state (open/closed, labels, title, body). If any mismatch is found, logs all discrepancies and exits with a recommendation to restart without `--resume`.

### Modules to modify

**KnoxProjectConfig** — Add `github` section with `authors` (string array, defaults to current `gh` user) and `defaults` (same shape as queue defaults: model, features, maxLoops, etc.).

**CLI (`knox queue`)** — Add required `--source` flag accepting `"directory"` or `"github"`. Remove implicit directory auto-detection. Wire up `GitHubIssueQueueSource` when source is `"github"`.

**PullRequestQueueOutput** — When the source is GitHub Issues, include `Closes #N` in PR body. For grouped items, include all close keywords. Accept an optional mapping of item IDs to issue numbers to generate the close keywords.

### Claim-then-verify protocol

1. Fetch all open issues with `agent/knox` label.
2. Filter out PRs, filter by `authors` list.
3. Parse all issue bodies into `QueueManifest`, validate dependency graph.
4. Identify eligible issues (no `knox/claimed` label, dependencies satisfiable).
5. For each eligible issue, in parallel up to concurrency limit:
   a. Post comment: `knox-claim:<queueRunId>`
   b. Add `knox/claimed` label
   c. Wait random 1-3 seconds
   d. Fetch issue timeline
   e. Check if this run's claim comment is the first claim comment
   f. If won: proceed. If lost: remove comment, remove label, skip issue.
6. Build final manifest from claimed issues only.

### State dual-write

Every `QueueSource.update()` call writes to both the local `.state.yaml` and the corresponding GitHub issue (label changes, comments). Cosmetic GitHub updates (adding `knox/running` label) that fail are logged as warnings. Critical updates (closing issues, adding `knox/failed`) that fail cause the item to be marked as failed locally.

### Issue lifecycle labels

| Label | Managed by | Purpose |
|---|---|---|
| `agent/knox` | User | Marks issue as Knox-eligible. Knox never touches this. |
| `knox/claimed` | Knox | Added during claim protocol, removed on all terminal states and cleanup. |
| `knox/running` | Knox | Added when execution starts, removed when done. Cosmetic — failure to apply is a warning. |
| `knox/failed` | Knox | Added on task failure. Removed on retry (next run). |
| `knox/blocked` | Knox | Added when a dependency fails. Removed on retry. |

All `knox/*` labels are auto-created on first use if they don't exist in the repo.

### Item ID format

`gh-<issue-number>-<slugified-title>` where the slug is: lowercased, non-alphanumeric characters replaced with hyphens, consecutive hyphens collapsed, trailing hyphens trimmed, title portion capped at 50 characters.

### Config schema addition

```yaml
# .knox/config.yaml
output: pr
github:
  authors: []  # empty = current gh user
  defaults:
    model: sonnet
    features:
      - node:22
    maxLoops: 3
```

### Breaking change: --source required

`knox queue` without `--source` will print an error with migration instructions. Existing directory workflows become `knox queue --source directory`. The `--file` and `--name` flags remain valid only with `--source directory`.

### Error handling classification

- **Critical failures** (affect correctness): initial fetch failure, claim protocol API errors, issue close failures. These cause item skip, item failure, or full run abort.
- **Cosmetic failures** (don't affect work): `knox/running` label, progress comments. These log a warning and continue.
- **Preflight failures**: `gh auth status` check, >100 issues warning. These happen before any work begins.

## Testing Decisions

Good tests for this feature verify external behavior through the module's public interface without coupling to internal implementation details. Since the primary external dependency is the `gh` CLI, tests should inject a mock `CommandRunner` (the pattern already established by `PullRequestQueueOutput` tests) to simulate GitHub API responses.

### Modules to test

**GitHubIssueQueueSource** — Integration-style tests using mock `CommandRunner`. Verify: issues are loaded into correct `QueueManifest` shape, state updates produce correct `gh` CLI calls, resume detects state mismatches and exits cleanly, authors filtering works with empty and explicit lists.

**ClaimProtocol** — Unit tests for the claim-then-verify logic. Verify: successful claim when first commenter, lost claim when another commenter is earlier in timeline, claim cleanup removes label and comment, random wait is within 1-3 second range.

**IssueMapper** — Unit tests for issue-to-QueueItem conversion. Verify: frontmatter parsing reuses `parseMarkdownTask`, `#N` dependsOn normalization, slug generation with edge cases (long titles, special characters, unicode), 50-char truncation.

**StateReconciler** — Unit tests for mismatch detection. Verify: all mismatch scenarios (status, title, description), clean pass-through when aligned, error message format lists all discrepancies.

**CLI changes** — Test that `--source` is required, that `--source github` wires up the correct source, and that `--source directory` preserves existing behavior.

### Prior art

Test patterns follow `test/queue/orchestrator_test.ts` (mock `QueueSource`, mock engine factory), `test/queue/file_queue_source_test.ts` (temp directory setup/cleanup), and `test/queue/output/pr_queue_output_test.ts` (mock `CommandRunner` for `gh` CLI assertions).

## Out of Scope

- **Cross-repo issues.** The source derives owner/repo from the current git remote. Fetching issues from a different repo is not supported in this iteration, though the constructor accepts repo as a parameter for future extensibility.
- **Polling/streaming mode.** Issues are fetched once at run start (batch mode). Continuous polling for new issues mid-run is not supported.
- **Rate limiting.** No built-in GitHub API throttling. The expected workload (tens of issues) is well within API limits.
- **External lock services.** The claim protocol uses only GitHub's own API (comments + timeline ordering). No Redis, DynamoDB, or other external coordination.
- **Issue creation.** Knox only reads and updates existing issues. It does not create issues.
- **Cross-repo dependencies.** `dependsOn` references are scoped to the current repo's issues.

## Further Notes

The `--source` flag becoming required is a breaking change. The error message when `--source` is omitted should include the exact command to run (e.g., `knox queue --source directory`) so migration is trivial.

The claim protocol's correctness depends on GitHub's timeline API returning events in server-timestamp order. This is a documented GitHub behavior but worth noting as an assumption. If GitHub ever changes timeline ordering semantics, the tiebreaker would need revisiting.

The `authors` default (current `gh` user when empty) means a fresh `knox queue --source github` in a repo with many `agent/knox` issues won't accidentally claim someone else's work. Teams that want shared intake must explicitly list authors.
