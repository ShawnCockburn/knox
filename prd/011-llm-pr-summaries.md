# PRD 011: LLM-Powered PR Titles and Descriptions

## Problem Statement

When Knox creates pull requests via `--output pr`, the titles and descriptions
are low quality. The PR title is the first line of the task instruction
truncated to 72 characters. The PR body is essentially empty — just the title
repeated, a "Created by Knox" footer, and dependency callouts for stacked PRs.
There is no summary of what actually changed, no context about why, and no
synthesis of grouped work.

For PRs sourced from GitHub Issues, there is no linkage back to the originating
issue — reviewers can't see the context, and merging doesn't auto-close the
issue.

This makes Knox-created PRs hard to review and disconnected from the work that
motivated them.

## Solution

Use an LLM call (Claude Haiku) to generate high-quality PR titles and
descriptions at PR creation time. The LLM receives task bodies, git commit
messages, and issue references as input, and produces a synthesized title and
structured description.

This is always on when output mode is `pr` — no opt-out toggle. If the LLM call
fails, Knox falls back to the current simple title and includes a visible note
in the PR body so reviewers know summarization failed.

To run the LLM call in a sandboxed environment consistent with Knox's security
model, introduce a new **UtilityContainer** abstraction — a lightweight
container that can run small Claude prompts without the full task execution
machinery (no git repo, no source provider, no progress tracking). PR
summarization is the first consumer; the abstraction generalizes to future
utility jobs (triage, labeling, classification).

## User Stories

1. As a PR reviewer, I want Knox PRs to have descriptive titles that summarize
   the actual change, so that I can triage PRs from my inbox without opening
   each one.

2. As a PR reviewer, I want Knox PR descriptions to include a summary of what
   changed and why, so that I have context before reading the diff.

3. As a PR reviewer, I want Knox PR descriptions to list key changes as bullet
   points derived from commits, so that I can quickly scan the scope of work.

4. As a team member, I want Knox PRs sourced from GitHub Issues to reference the
   originating issue with `Closes #N`, so that merging the PR auto-closes the
   issue.

5. As a team member, I want Knox PRs sourced from GitHub Issues to display the
   issue number and title in the PR description, so that reviewers can see the
   full context at a glance.

6. As a user with grouped tasks, I want the PR title to synthesize all tasks in
   the group into a single coherent title, so that the PR represents the
   combined scope rather than an arbitrary single task.

7. As a user with grouped tasks, I want the PR description to reflect all tasks
   that contributed to the branch, so that no work is hidden.

8. As a user with grouped tasks sourced from multiple GitHub Issues, I want the
   PR to include `Closes #N` for every issue in the group, so that merging one
   PR closes all related issues.

9. As a user, I want PR summarization to never block PR creation, so that a
   transient LLM failure doesn't prevent my work from being delivered.

10. As a user, I want to see a visible note in the PR body when summarization
    fails, so that I know the description is incomplete and can add context
    manually.

11. As a user running `knox run --output pr` (single task mode), I want the same
    high-quality LLM-generated title and description, so that single-task PRs
    are as polished as queue PRs.

12. As a Knox developer, I want the UtilityContainer abstraction to be reusable
    for future lightweight LLM jobs, so that I don't have to reinvent container
    management for each new use case.

13. As a Knox developer, I want UtilityContainer to use the base image with no
    features, so that utility jobs start fast and don't require image builds.

14. As a Knox developer, I want UtilityContainer to enforce the same network
    restrictions as task containers (Anthropic API IPs only), so that the
    security model is consistent.

## Implementation Decisions

### UtilityContainer (new module)

A lightweight container abstraction wrapping `DockerRuntime`. Unlike
`ContainerSession`, it has no source provider, no git workspace, no progress
tracking, and no task execution loop.

- Always uses the base image (`knox-agent:latest`) via
  `ImageManager.ensureBaseImage()`.
- Network restricted to Anthropic API IPs using the existing `restrictNetwork`
  logic from `DockerRuntime`.
- Input delivered via stdin pipe to the container process.
- Output captured from stdout.
- Interface: `create(options)`, `run(command, stdin) -> stdout`, `dispose()`.
- Container lifecycle: create on `create()`, remove on `dispose()`. The `run()`
  method executes a single command with stdin piped in and stdout captured.

### PrSummaryGenerator (new module)

Responsible for constructing the LLM prompt, invoking Claude via
UtilityContainer, and parsing the response.

- Constructs a prompt containing: task bodies (all in group), git commit
  messages from the branch, and issue references (if sourced from GitHub
  Issues).
- Invokes `claude -p --model haiku` inside the UtilityContainer with the prompt
  piped via stdin.
- Prompt instructs the LLM to respond with `<title>` and `<body>` XML tags.
- Parses the tags from stdout using simple regex extraction.
- Title instruction: under 72 characters, summarize the overall change.
- Body instruction: 2-4 sentence summary, then bullet list of key changes.
- On any failure (container error, parse error, timeout), returns a fallback
  result with the current simple title and a body containing a visible failure
  note: "_Knox was unable to generate a summary for this PR. Review the commits
  for details._"
- One attempt, no retries.
- The prompt template lives as a template string in the module code, not a
  separate file.

### PullRequestQueueOutput (modified)

- Accepts an optional `issueNumbers: Map<string, number>` (mapping item ID to
  GitHub Issue number) via constructor options or `deliver()` parameter.
- Before creating each PR, calls `PrSummaryGenerator` with:
  - All task bodies for items sharing the branch (grouped work).
  - Git commit messages from the branch (gathered via `git log` on the host
    before PR creation).
  - Issue numbers and titles for all items in the group.
- Uses the LLM-generated title instead of `prTitle()` first-line extraction.
- Builds the PR body with the following structure:
  1. `## Summary` — LLM-generated summary.
  2. `## Changes` — LLM-generated bullet list from commits.
  3. `## Tasks` — `Closes #N (issue title)` for each GitHub Issue in the group.
     Only present when the source is GitHub Issues.
  4. `## Dependencies` — existing stacking callout, unchanged.
  5. Footer: `---` and `*Created by Knox*`.
- The `buildPrBody()` function is updated to accept and assemble these sections.

### Issue number plumbing

- `GitHubIssueQueueSource` already tracks issue numbers via `getIssueNumber()`.
- The CLI passes the issue number map from the source to
  `PullRequestQueueOutput` at construction time.
- For non-GitHub-Issue sources, the map is empty and the Tasks section is
  omitted.
- Issue titles are available from the manifest's `QueueItem.task` field (first
  line), which is derived from the GitHub Issue title during mapping.

### createSinglePR (modified)

- The existing `createSinglePR()` function for `knox run --output pr` is updated
  to use `PrSummaryGenerator` for title and description generation.
- Input: single task body + commit messages from the branch.
- No issue number support (single run mode doesn't use GitHub Issues as source).
- Same fallback behavior on failure.

### Commit message gathering

- Commit messages are gathered on the host side before PR creation using
  `git log --format=%s <default-branch>..<pr-branch>` via the existing
  `CommandRunner` abstraction.
- This avoids needing the repo inside the utility container.

### Container lifecycle for queue runs

- One UtilityContainer is created per `deliver()` call (not per PR), shared
  across all PRs in the queue run.
- The container is disposed after all PRs are created, even on failure.
- Auth resolution and network IP resolution are reused from the existing CLI
  pipeline — the PR output stage receives these as constructor dependencies.

## Testing Decisions

Tests should verify external behavior through the public interface of each
module, not implementation details. Mock external dependencies (Docker runtime,
command runner) at the boundary.

### UtilityContainer

- Test that `create()` calls `createContainer` with the base image, network
  enabled, and `NET_ADMIN` capability.
- Test that `create()` calls `restrictNetwork` with provided IPs.
- Test that `run()` executes the command with stdin piped and returns stdout.
- Test that `dispose()` calls `remove()` and is idempotent.
- Test that `dispose()` is called on `create()` failure (cleanup).
- Use `MockRuntime` (existing test utility) to mock `DockerRuntime`.

### PrSummaryGenerator

- Test that the prompt includes all task bodies, commit messages, and issue
  refs.
- Test that a well-formed LLM response is parsed into title and body.
- Test that a malformed response (missing tags, empty, garbage) returns the
  fallback title and failure-note body.
- Test that a container/execution failure returns the fallback.
- Test grouped input: multiple task bodies produce a single synthesized prompt.
- Mock the UtilityContainer to return canned stdout strings.

### PullRequestQueueOutput (extended)

- Test that PRs include the LLM-generated title and body when summarization
  succeeds.
- Test that PRs include the fallback title and failure note when summarization
  fails.
- Test that the Tasks section includes `Closes #N` for each issue number in the
  group.
- Test that the Tasks section is omitted when no issue numbers are provided.
- Test that grouped items produce a single PR with all issue references.
- Test that the Dependencies section is preserved for stacked PRs.
- Follows existing test patterns: mock `CommandRunner`, verify `gh pr create`
  arguments and body content.

### Prior art

- `test/queue/pr_queue_output_test.ts` — mock CommandRunner pattern,
  `makeReport` builder, call sequence verification.
- `test/session/container_session_test.ts` — MockRuntime pattern,
  `createOptions` builder, call sequence and argument verification.

## Out of Scope

- **User-customizable PR templates.** The PR body structure is fixed. Custom
  templates may be added later if needed.
- **Configurable summarization model.** Always uses Haiku. A `pr.model` config
  option is not needed now.
- **Opt-out toggle for summarization.** Always on when output mode is `pr`.
- **Retry logic for failed LLM calls.** One attempt with graceful fallback.
- **PR description updates.** If a PR already exists (branch already pushed),
  Knox does not update its description. This is existing behavior and unchanged.
- **Summarization for branch output mode.** Only applies to `--output pr`.
- **UtilityContainer feature support.** Utility containers always use the base
  image. Feature installation is not supported — if a future use case needs it,
  the abstraction can be extended then.
- **Full "utility job" CLI subcommand.** UtilityContainer is an internal
  abstraction, not exposed as a user-facing command.

## Further Notes

- The UtilityContainer abstraction represents a conceptual split in what
  containers do in Knox: task execution (heavy, long-lived, git-aware) vs.
  utility jobs (light, short-lived, stateless). This is the first utility
  container use case, so the interface should be kept minimal and extended only
  when a second use case arrives.
- The LLM prompt should instruct Haiku to stay grounded in the provided inputs
  and not fabricate details. The prompt includes an explicit rule: "Do not
  fabricate details not evident from the tasks and commits."
- For grouped PRs where multiple GitHub Issues contribute, all `Closes #N`
  keywords are included. GitHub supports multiple closing keywords in a single
  PR body and will close all referenced issues on merge.
