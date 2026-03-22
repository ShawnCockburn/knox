# Knox — Handoff Redesign: Source/Sink Strategy Pattern

## Problem Statement

Knox currently hands agent work back to the host by applying `git format-patch`
/ `git am` patches directly to the host repository. This approach has several
problems:

1. **Host mutation**: Knox checks out a new branch on the host, changing the
   user's working tree out from under them.
2. **Fragile patching**: If the host has diverged since the container snapshot,
   `git am` fails — triggering a fallback that dumps the entire container
   workspace (including `.git/objects`) into a `knox-output-<slug>/` directory
   inside the project.
3. **Project pollution**: The fallback copy creates a nested directory of the
   full workspace inside the host project, which must be manually cleaned up.
4. **No parallel support**: Multiple agents finishing simultaneously would race
   on `git checkout -b` and `git am`.
5. **No extensibility**: The extraction logic is hardcoded — there's no path to
   remote output, PR creation, or alternative storage without rewriting the
   internals.

## Solution

Replace the monolithic `ResultExtractor` with a strategy pattern using two
container-agnostic interfaces: `SourceProvider` (how code enters the container)
and `ResultSink` (how agent work leaves the container). Knox orchestrates
between them, owning the container lifecycle. Neither the source provider nor
the sink know that containers exist.

The MVP implements `GitSourceProvider` (shallow clone from local repo) and
`GitBranchSink` (create branch via git bundle fetch without switching checkout).
The architecture supports future sinks (remote git, filesystem, PR) via the
Open/Closed Principle.

Key changes:

- Source is copied via `git clone --depth 1` (committed state only — security:
  prevents history leaking sensitive data).
- Agent work is transferred via `git bundle` instead of `git format-patch` —
  eliminating patch conflicts entirely.
- Branches are created without switching the host's checkout.
- The fallback directory copy is removed.
- Knox generates a run ID upfront that correlates container, branch, temp files,
  and result metadata.
- A commit nudge mechanism handles agents that forget to commit.
- Structured CLI output with timing, metadata, and next-step hints.

## User Stories

1. As a developer, I want knox to create a result branch without switching my
   checked-out branch, so that my working tree is undisturbed when the agent
   finishes.
2. As a developer, I want knox to use `git clone --depth 1` when copying source
   into the container, so that sensitive history (reverted secrets, old
   credentials in diffs) is never exposed to the agent.
3. As a developer, I want knox to warn me if I have uncommitted changes when
   starting a run, so that I understand only committed state will be sent to the
   agent.
4. As a developer, I want knox to transfer agent work via git bundle instead of
   patches, so that extraction never fails due to merge conflicts or diverged
   history.
5. As a developer, I want knox to remove the fallback directory copy mechanism,
   so that my project directory is never polluted with `knox-output-*`
   directories.
6. As a developer, I want knox to nudge the agent to commit if it finishes with
   uncommitted work, so that meaningful commit messages are preserved rather
   than losing work or getting generic auto-commit messages.
7. As a developer, I want knox to auto-commit as a last resort if the nudge
   fails, so that agent work is never lost even if the agent ignores the commit
   instruction.
8. As a developer, I want each knox run to have a unique run ID visible in the
   branch name, container name, and output, so that I can correlate artifacts
   from the same run.
9. As a developer, I want knox to print a structured summary when it finishes
   (status, branch, commits, duration, loops, model), so that I can immediately
   understand the outcome without reading scrollback.
10. As a developer, I want knox to print next-step hints (e.g., `git log`,
    `git merge`) in the summary, so that I know exactly what to do with the
    results.
11. As a developer, I want the source and sink to be injectable via
    `KnoxOptions`, so that I can provide custom implementations for testing or
    alternative workflows.
12. As a developer, I want knox to default to `GitSourceProvider` and
    `GitBranchSink` when no custom implementations are provided, so that the
    common case requires zero configuration.
13. As a developer running multiple agents in parallel, I want each agent to
    create its own branch without race conditions, so that parallel execution is
    safe.
14. As a library consumer, I want to implement the `ResultSink` interface to
    send agent work to a remote git server, S3, or a PR, so that I can extend
    knox for my infrastructure without modifying knox internals.
15. As a library consumer, I want `SinkResult` to be a discriminated union with
    a strategy field, so that I can switch on the result type and access
    strategy-specific fields with type safety.
16. As a developer, I want the branch name format to be configurable, so that I
    can adopt naming conventions that fit my team's workflow.
17. As a developer, I want knox to report whether it had to auto-commit (nudge
    or mechanical fallback), so that I can tell whether the agent followed
    instructions.
18. As a developer, I want knox to report whether the check command passed or
    failed (or was not configured), so that I can trust the completion status.
19. As a developer, I want all temp artifacts for a run collected in a single
    `/tmp/knox-<runId>/` directory, so that cleanup is atomic and debugging
    failed runs is easy.
20. As a developer, I want knox to clean up the temp directory in a finally
    block, so that disk space is reclaimed even if the run crashes.
21. As a developer, I want `KnoxResult` to include timing metadata (startedAt,
    finishedAt, durationMs), so that I can track agent performance across runs.

## Implementation Decisions

### Run ID

Knox generates an 8-hex-character run ID (first 8 chars of a UUID) at the start
of each run. This ID is used for:

- Container name: `knox-<runId>`
- Branch name suffix: `knox/<slug>-<runId>`
- Temp directory: `/tmp/knox-<runId>/`
- Result correlation in `KnoxResult`

### Temp Directory

All temp artifacts for a run are stored under `/tmp/knox-<runId>/`:

- `source/` — shallow clone from `GitSourceProvider`
- `bundle.git` — git bundle extracted from container
- `prompt.txt` — current loop prompt (overwritten each loop)

Cleaned up in a `finally` block at the end of `Knox.run()`.

### SourceProvider Interface

```
SourceProvider
  prepare(runId: string) → { hostPath: string, metadata: SourceMetadata }
  cleanup(runId: string) → void
```

Container-agnostic. Prepares source material on the host filesystem, tagged with
the run ID. Knox handles copying into the container.

### SourceMetadata (Discriminated Union)

```
SourceStrategy enum: HostGit (MVP only)

HostGitSourceMetadata
  strategy: SourceStrategy.HostGit
  baseCommit: string   — host HEAD SHA at snapshot time
  repoPath: string     — absolute path to host repo
```

### GitSourceProvider (MVP Implementation)

1. Record host `HEAD` SHA → `SourceMetadata.baseCommit`
2. Check for dirty working tree → warn if dirty (not an error)
3. `git clone --depth 1 file:///host/repo /tmp/knox-<runId>/source/`
4. Return `{ hostPath: "/tmp/knox-<runId>/source/", metadata }`
5. Cleanup removes `/tmp/knox-<runId>/source/`

Depth 1 is a security decision: the agent gets only the committed tree at HEAD.
Sensitive history stays on the host. This is documented, not configurable.

### ResultSink Interface

```
ResultSink
  collect(runId: string, bundlePath: string, metadata: SourceMetadata) → SinkResult
  cleanup(runId: string) → void
```

Container-agnostic. Receives a git bundle file path on the host and the source
metadata. Knox handles extracting the bundle from the container.

### SinkResult (Discriminated Union)

```
SinkStrategy enum: HostGit (MVP only; future: Filesystem, RemoteGit, PR)

BaseSinkResult
  strategy: SinkStrategy
  commitCount: number
  autoCommitted: boolean

HostGitSinkResult extends BaseSinkResult
  strategy: SinkStrategy.HostGit
  branchName: string
```

Additional variants (FilesystemSinkResult, RemoteGitSinkResult, PRSinkResult)
are added when their implementations are built, not before.

### GitBranchSink (MVP Implementation)

1. `git fetch /tmp/knox-<runId>/bundle.git HEAD:refs/heads/knox/<slug>-<runId>`
   on the host
2. Branch is created without switching checkout
3. Return `HostGitSinkResult` with branch name

Uses `HEAD` ref from the bundle — avoids needing to know the branch name inside
the container.

### Git Bundle Transfer

Instead of `git format-patch` → `git am` (which can fail on conflicts), the new
flow:

1. Inside container: `git bundle create /tmp/knox.bundle HEAD`
2. `docker cp` bundle out to `/tmp/knox-<runId>/bundle.git`
3. On host: `git fetch` from bundle to create branch ref

Git bundle transfers exact objects. No patch application, no conflicts, no
failure modes beyond "container has no commits." The base commit (from
`SourceMetadata.baseCommit`) must exist in the host repo, which it will since it
came from a depth-1 clone of that repo.

### Commit Nudge Mechanism

When the agent finishes (completion or max loops) with uncommitted changes:

1. **Nudge**: Run claude one more time with a narrow prompt: "You have
   uncommitted changes. Review the diff and status, then commit with a
   meaningful conventional commit message. Do NOT make further code changes."
   This does NOT count as a loop iteration.
2. **Mechanical fallback**: If the nudge fails to produce a commit, knox runs
   `git add -A && git commit -m "knox: auto-commit uncommitted agent work"`
   directly.

The nudge runs as the same `claude -p --dangerously-skip-permissions` invocation
inside the container. The constraint is in the prompt, not the tooling.

### Container Coupling

Knox is the only module that talks to the container runtime. The orchestration
flow:

1. Knox generates runId
2. Knox creates `/tmp/knox-<runId>/`
3. `SourceProvider.prepare(runId)` → hostPath + metadata (no container
   knowledge)
4. Knox creates container (`knox-<runId>`)
5. Knox copies hostPath into container, fixes ownership
6. `SourceProvider.cleanup(runId)`
7. Knox restricts network, runs agent loops
8. Knox handles commit nudge if needed
9. Knox runs `git bundle create` inside container, copies bundle out
10. `ResultSink.collect(runId, bundlePath, metadata)` → SinkResult (no container
    knowledge)
11. `ResultSink.cleanup(runId)`
12. Knox removes container, cleans up temp dir
13. Knox returns `KnoxResult`

### Strategy Wiring

`KnoxOptions` accepts optional `sourceProvider` and `resultSink`. If not
provided, Knox defaults to `GitSourceProvider` and `GitBranchSink`. This keeps
Knox testable (inject mocks) and extensible (future callers inject custom
strategies).

### KnoxResult

```
KnoxResult
  completed: boolean
  loopsRun: number
  maxLoops: number
  startedAt: string (ISO timestamp)
  finishedAt: string (ISO timestamp)
  durationMs: number
  model: string
  task: string
  autoCommitted: boolean
  checkPassed: boolean | null (null if no --check)
  sink: SinkResult
```

### CLI Output

On completion, the CLI prints a structured summary:

```
[knox] Done.
  Status:      completed (3/10 loops)
  Duration:    4m 32s
  Model:       sonnet
  Branch:      knox/add-mit-licence-a3f2b1c0
  Commits:     2
  Auto-commit: no
  Check:       passed
  Strategy:    host-git

  To review:   git log main..knox/add-mit-licence-a3f2b1c0
  To merge:    git merge knox/add-mit-licence-a3f2b1c0
```

Next-step hints are strategy-specific (git commands for HostGit, URL for future
PR sink, etc.).

### Preflight Changes

Add a dirty working tree check: if `git status --porcelain` shows changes, emit
a warning. Do not error — the user may intentionally have local changes they
don't want the agent touching.

### Modules Removed

`ResultExtractor` (`src/result/result_extractor.ts`) is replaced entirely by the
sink pattern + commit nudge. The `taskSlug()` utility function is retained
(moved or re-exported).

## Testing Decisions

### Testing Philosophy

Tests verify external behavior through module interfaces, not implementation
details. Tests are deterministic and do not depend on external services (Docker,
Claude API) unless explicitly marked as integration tests. The new source/sink
modules are container-agnostic, so they can be tested with real git repos in
temp directories — no mocks needed for their core logic.

### Modules Under Test

1. **GitSourceProvider** — Test that `prepare()` produces a shallow clone at the
   correct depth, records the correct base commit, returns a valid host path.
   Test that dirty working tree produces a warning. Test that cleanup removes
   the temp directory. Uses real git repos in `Deno.makeTempDir()`.

2. **GitBranchSink** — Test that `collect()` creates a branch from a bundle
   without switching the host's checked-out branch. Test that the branch
   contains the expected commits. Test branch name collision handling. Uses real
   git repos and bundles in temp directories.

3. **Knox orchestrator** — Update existing integration test
   (`test/knox_test.ts`) for the new flow. Mock source provider and result sink
   to verify wiring. Verify run ID propagation, commit nudge triggering, and
   `KnoxResult` metadata.

4. **Commit nudge** — Test that uncommitted changes trigger a nudge invocation.
   Test that persistent uncommitted changes after nudge trigger mechanical
   auto-commit. Uses mock runtime.

5. **CLI output** — Test structured summary formatting for different scenarios:
   completed, max loops, auto-committed, check passed/failed/absent.

6. **Preflight** — Add test for dirty working tree warning.

### Prior Art

Existing tests use `MockRuntime` (`test/runtime/mock_runtime.ts`) with call
recording and configurable return values. The new source/sink tests can use real
git operations in temp directories since they don't depend on containers. Follow
the existing pattern of `Deno.test()` with `t.step()` nesting, `@std/assert`
assertions, and try/finally cleanup.

## Out of Scope

- **Alternative sink implementations** (RemoteGit, Filesystem, PR) — only
  HostGit for MVP. The interfaces are designed for future extension.
- **Alternative source implementations** — only HostGit for MVP.
- **Configurable clone depth** — depth 1 only, security rationale documented.
- **Config files** — MVP uses CLI flags and `KnoxOptions` only.
- **Parallel agent execution** — the design supports it (no host checkout
  mutation, unique run IDs), but orchestration of multiple agents is not built
  in this PRD.
- **Queue system / task dependencies** — future work.
- **Remote execution** — out of scope for knox itself.
- **Branch naming configuration UI** — the format is configurable via
  `KnoxOptions` but no CLI flag is added in this PRD.

## Further Notes

- The `git bundle` approach eliminates the entire class of `git am` failures
  that caused the fallback copy problem. Bundles transfer exact git objects — no
  patching, no conflict resolution.
- The depth-1 clone is a deliberate security decision, not a performance
  optimization. It ensures the agent cannot access historical commits that might
  contain sensitive data. This should be documented prominently.
- The discriminated union pattern for `SinkResult` / `SourceMetadata` ensures
  that adding a new strategy is a compile-time-visible change — you add an enum
  member and a new interface variant, and TypeScript forces you to handle it
  everywhere.
- The commit nudge is a pragmatic compromise: it gives the agent a chance to
  write a meaningful commit message (better for the user reviewing the branch),
  but doesn't block on agent cooperation.
- Run ID correlation (`knox-<runId>` appearing in container name, branch name,
  temp directory) makes debugging straightforward — if something goes wrong, all
  artifacts from a run are findable by one string.
