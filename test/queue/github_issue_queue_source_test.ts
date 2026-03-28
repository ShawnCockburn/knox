import { assertEquals, assertStringIncludes } from "@std/assert";
import { GitHubIssueQueueSource } from "../../src/queue/github_issue_queue_source.ts";
import type { CommandRunner } from "../../src/queue/output/pr_queue_output.ts";
import type { GitHubIssue } from "../../src/queue/github_client.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunnerCall {
  args: string[];
  cwd: string;
}

function mockRunner(
  handler: (args: string[], cwd: string) => {
    success: boolean;
    stdout: string;
    stderr: string;
    code: number;
  },
): { runner: CommandRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: CommandRunner = (args, cwd) => {
    calls.push({ args: [...args], cwd });
    return Promise.resolve(handler(args, cwd));
  };
  return { runner, calls };
}

function makeIssue(
  overrides: Partial<GitHubIssue> & { number: number; title: string },
): GitHubIssue {
  return {
    body: "Default task body",
    author: { login: "testuser" },
    labels: [{ name: "agent/knox" }],
    ...overrides,
  };
}

/** Build a runner that returns a list of issues for gh issue list. */
function issueRunner(
  issues: GitHubIssue[],
): { runner: CommandRunner; calls: RunnerCall[] } {
  return mockRunner((args) => {
    const cmd = `${args[0]} ${args[1]}`;

    // Label creation (ensureLabels)
    if (args[0] === "gh" && args[1] === "label") {
      return { success: true, stdout: "", stderr: "", code: 0 };
    }

    // Issue list
    if (cmd === "gh issue") {
      return {
        success: true,
        stdout: JSON.stringify(issues),
        stderr: "",
        code: 0,
      };
    }

    return { success: true, stdout: "", stderr: "", code: 0 };
  });
}

async function withTempState(
  fn: (statePath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "knox-gh-source-test-" });
  const statePath = `${dir}/github.state.yaml`;
  try {
    await fn(statePath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("GitHubIssueQueueSource — loads issues into a valid manifest", async () => {
  await withTempState(async (statePath) => {
    const issues = [
      makeIssue({ number: 1, title: "Add feature A", body: "Build feature A" }),
      makeIssue({ number: 2, title: "Add feature B", body: "Build feature B" }),
    ];

    const { runner } = issueRunner(issues);
    const source = new GitHubIssueQueueSource({
      cwd: "/repo",
      statePath,
      runner,
    });

    const result = await source.load();
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.manifest.items.length, 2);
      assertEquals(result.manifest.items[0].id, "gh-1-add-feature-a");
      assertEquals(result.manifest.items[0].task, "Build feature A");
      assertEquals(result.manifest.items[1].id, "gh-2-add-feature-b");
    }
  });
});

Deno.test("GitHubIssueQueueSource — filters out pull requests", async () => {
  await withTempState(async (statePath) => {
    const issues = [
      makeIssue({ number: 1, title: "Real issue", body: "Task body" }),
      {
        ...makeIssue({ number: 2, title: "A pull request", body: "PR body" }),
        pullRequest: { url: "https://github.com/org/repo/pull/2" },
      },
    ];

    const { runner } = issueRunner(issues);
    const source = new GitHubIssueQueueSource({
      cwd: "/repo",
      statePath,
      runner,
    });

    const result = await source.load();
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.manifest.items.length, 1);
      assertEquals(result.manifest.items[0].id, "gh-1-real-issue");
    }
  });
});

Deno.test("GitHubIssueQueueSource — returns error when no issues found", async () => {
  await withTempState(async (statePath) => {
    const { runner } = issueRunner([]);
    const source = new GitHubIssueQueueSource({
      cwd: "/repo",
      statePath,
      runner,
    });

    const result = await source.load();
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.errors[0].message, "No open issues");
    }
  });
});

Deno.test("GitHubIssueQueueSource — returns error when all issues are PRs", async () => {
  await withTempState(async (statePath) => {
    const issues = [
      {
        ...makeIssue({ number: 1, title: "PR only", body: "body" }),
        pullRequest: { url: "https://github.com/org/repo/pull/1" },
      },
    ];

    const { runner } = issueRunner(issues);
    const source = new GitHubIssueQueueSource({
      cwd: "/repo",
      statePath,
      runner,
    });

    const result = await source.load();
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.errors[0].message, "pull requests");
    }
  });
});

Deno.test("GitHubIssueQueueSource — parses frontmatter from issue body", async () => {
  await withTempState(async (statePath) => {
    const issues = [
      makeIssue({
        number: 5,
        title: "Configured task",
        body: `---
model: opus
maxLoops: 3
---
Build with specific config`,
      }),
    ];

    const { runner } = issueRunner(issues);
    const source = new GitHubIssueQueueSource({
      cwd: "/repo",
      statePath,
      runner,
    });

    const result = await source.load();
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.manifest.items[0].model, "opus");
      assertEquals(result.manifest.items[0].maxLoops, 3);
      assertEquals(result.manifest.items[0].task, "Build with specific config");
    }
  });
});

Deno.test("GitHubIssueQueueSource — applies queue-level defaults", async () => {
  await withTempState(async (statePath) => {
    const issues = [
      makeIssue({ number: 1, title: "Task", body: "Do the thing" }),
    ];

    const { runner } = issueRunner(issues);
    const source = new GitHubIssueQueueSource({
      cwd: "/repo",
      statePath,
      defaults: { model: "opus", maxLoops: 20 },
      runner,
    });

    const result = await source.load();
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.manifest.defaults?.model, "opus");
      assertEquals(result.manifest.defaults?.maxLoops, 20);
    }
  });
});

Deno.test("GitHubIssueQueueSource — auto-creates knox labels", async () => {
  await withTempState(async (statePath) => {
    const issues = [
      makeIssue({ number: 1, title: "Task", body: "Do the thing" }),
    ];

    const { runner, calls } = issueRunner(issues);
    const source = new GitHubIssueQueueSource({
      cwd: "/repo",
      statePath,
      runner,
    });

    await source.load();

    // Check that label create was called for all knox labels
    const labelCalls = calls.filter(
      (c) => c.args[0] === "gh" && c.args[1] === "label" && c.args[2] === "create",
    );
    assertEquals(labelCalls.length, 4); // knox/claimed, knox/running, knox/failed, knox/blocked
  });
});

Deno.test("GitHubIssueQueueSource — state read/write/update roundtrip", async () => {
  await withTempState(async (statePath) => {
    const issues = [
      makeIssue({ number: 1, title: "Task A", body: "Do A" }),
    ];

    const { runner } = issueRunner(issues);
    const source = new GitHubIssueQueueSource({
      cwd: "/repo",
      statePath,
      runner,
    });

    // No state file initially
    assertEquals(await source.readState(), null);

    // Write state
    await source.writeState({
      queueRunId: "run-123",
      startedAt: "2026-01-01T00:00:00Z",
      items: {
        "gh-1-task-a": { status: "pending" },
      },
    });

    const state = await source.readState();
    assertEquals(state!.queueRunId, "run-123");
    assertEquals(state!.items["gh-1-task-a"].status, "pending");

    // Update an item
    await source.update("gh-1-task-a", { status: "in_progress" });
    const updated = await source.readState();
    assertEquals(updated!.items["gh-1-task-a"].status, "in_progress");
  });
});

Deno.test("GitHubIssueQueueSource — update with completed status closes issue", async () => {
  await withTempState(async (statePath) => {
    const issues = [
      makeIssue({ number: 42, title: "Closeable", body: "Do and close" }),
    ];

    const closedIssues: number[] = [];
    const removedLabels: Array<{ issue: number; label: string }> = [];

    const { runner } = mockRunner((args) => {
      // Label creation
      if (args[0] === "gh" && args[1] === "label") {
        return { success: true, stdout: "", stderr: "", code: 0 };
      }
      // Issue list
      if (args[0] === "gh" && args[1] === "issue" && args[2] === "list") {
        return {
          success: true,
          stdout: JSON.stringify(issues),
          stderr: "",
          code: 0,
        };
      }
      // Issue close
      if (args[0] === "gh" && args[1] === "issue" && args[2] === "close") {
        closedIssues.push(parseInt(args[3]));
        return { success: true, stdout: "", stderr: "", code: 0 };
      }
      // Issue edit (label removal)
      if (args[0] === "gh" && args[1] === "issue" && args[2] === "edit" && args.includes("--remove-label")) {
        const labelIdx = args.indexOf("--remove-label");
        removedLabels.push({
          issue: parseInt(args[3]),
          label: args[labelIdx + 1],
        });
        return { success: true, stdout: "", stderr: "", code: 0 };
      }
      return { success: true, stdout: "", stderr: "", code: 0 };
    });

    const source = new GitHubIssueQueueSource({
      cwd: "/repo",
      statePath,
      runner,
    });

    // Load to populate issueNumbers map
    await source.load();

    // Write initial state so update can read it
    await source.writeState({
      queueRunId: "run-1",
      startedAt: "2026-01-01T00:00:00Z",
      items: {
        "gh-42-closeable": { status: "in_progress" },
      },
    });

    // Update to completed
    await source.update("gh-42-closeable", { status: "completed" });

    assertEquals(closedIssues, [42]);
    assertEquals(removedLabels.length, 1);
    assertEquals(removedLabels[0].issue, 42);
    assertEquals(removedLabels[0].label, "knox/claimed");
  });
});

Deno.test("GitHubIssueQueueSource — getIssueNumber returns correct mapping", async () => {
  await withTempState(async (statePath) => {
    const issues = [
      makeIssue({ number: 99, title: "Special Issue", body: "Do something" }),
    ];

    const { runner } = issueRunner(issues);
    const source = new GitHubIssueQueueSource({
      cwd: "/repo",
      statePath,
      runner,
    });

    await source.load();
    assertEquals(source.getIssueNumber("gh-99-special-issue"), 99);
    assertEquals(source.getIssueNumber("nonexistent"), undefined);
  });
});

Deno.test("GitHubIssueQueueSource — returns parse errors for malformed issue bodies", async () => {
  await withTempState(async (statePath) => {
    const issues = [
      makeIssue({
        number: 1,
        title: "Bad YAML",
        body: `---
model: [unclosed
---
Task body`,
      }),
    ];

    const { runner } = issueRunner(issues);
    const source = new GitHubIssueQueueSource({
      cwd: "/repo",
      statePath,
      runner,
    });

    const result = await source.load();
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.errors.length >= 1, true);
      assertStringIncludes(result.errors[0].message, "Issue #1");
    }
  });
});

Deno.test("GitHubIssueQueueSource — validates dependency graph (broken refs)", async () => {
  await withTempState(async (statePath) => {
    const issues = [
      makeIssue({
        number: 1,
        title: "Depends on nothing",
        body: `---
dependsOn:
  - nonexistent-item
---
Task body`,
      }),
    ];

    const { runner } = issueRunner(issues);
    const source = new GitHubIssueQueueSource({
      cwd: "/repo",
      statePath,
      runner,
    });

    const result = await source.load();
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.errors[0].message, "nonexistent-item");
    }
  });
});
