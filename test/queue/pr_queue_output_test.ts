import { assertEquals, assertRejects } from "@std/assert";
import {
  PullRequestQueueOutput,
} from "../../src/queue/output/pr_queue_output.ts";
import type { CommandRunner } from "../../src/queue/output/pr_queue_output.ts";
import type { QueueReport } from "../../src/queue/orchestrator.ts";
import type { QueueManifest } from "../../src/queue/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RunnerResponse = {
  success: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

/** Recorded call to the mock runner. */
interface RunnerCall {
  args: string[];
  cwd: string;
}

/**
 * Build a mock runner. The `handler` receives each call and returns a
 * response. Calls are also recorded for assertions.
 */
function mockRunner(
  handler: (args: string[], cwd: string) => RunnerResponse,
): { runner: CommandRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: CommandRunner = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    return handler(args, cwd);
  };
  return { runner, calls };
}

/** Standard happy-path runner that fakes gh and git responses. */
function happyRunner(
  prResponses: Map<string, string> = new Map(),
  existingPrResponses: Map<string, RunnerResponse> = new Map(),
): { runner: CommandRunner; calls: RunnerCall[] } {
  let prCounter = 1;

  return mockRunner((args) => {
    const cmd = args.join(" ");

    // Preflight
    if (cmd === "gh auth status") {
      return { success: true, stdout: "Logged in to github.com", stderr: "", code: 0 };
    }

    // Default branch detection
    if (cmd === "git symbolic-ref refs/remotes/origin/HEAD") {
      return {
        success: true,
        stdout: "refs/remotes/origin/main",
        stderr: "",
        code: 0,
      };
    }

    // gh pr create — extract head branch from args
    if (args[0] === "gh" && args[1] === "pr" && args[2] === "create") {
      const headIdx = args.indexOf("--head");
      const branch = headIdx !== -1 ? args[headIdx + 1] : "unknown";

      // Check if caller wants an "already exists" response for this branch
      if (prResponses.has(branch)) {
        return {
          success: false,
          stdout: "",
          stderr: `a pull request for branch '${branch}' already exists`,
          code: 1,
        };
      }

      const n = prCounter++;
      return {
        success: true,
        stdout: `https://github.com/org/repo/pull/${n}`,
        stderr: "",
        code: 0,
      };
    }

    // gh pr view (for existing PR lookup)
    if (args[0] === "gh" && args[1] === "pr" && args[2] === "view") {
      const headIdx = args.indexOf("--head");
      const branch = headIdx !== -1 ? args[headIdx + 1] : "";
      const resp = existingPrResponses.get(branch);
      if (resp) return resp;
      return {
        success: true,
        stdout: JSON.stringify({
          number: 99,
          url: `https://github.com/org/repo/pull/99`,
        }),
        stderr: "",
        code: 0,
      };
    }

    return { success: false, stdout: "", stderr: `Unexpected: ${cmd}`, code: 1 };
  });
}

/** Build a minimal QueueReport. */
function makeReport(
  items: Array<{
    id: string;
    status: string;
    branch?: string;
    blockedBy?: string;
  }>,
): QueueReport {
  return {
    queueRunId: "run-1",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 100,
    manifest: { items: [] },
    items: items.map((i) => ({
      id: i.id,
      status: i.status,
      branch: i.branch,
      blockedBy: i.blockedBy,
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("PullRequestQueueOutput — independent items produce individual PRs targeting default branch", async () => {
  const manifest: QueueManifest = {
    items: [
      { id: "a", task: "Add feature A" },
      { id: "b", task: "Add feature B" },
    ],
  };
  const report = makeReport([
    { id: "a", status: "completed", branch: "knox/a-branch" },
    { id: "b", status: "completed", branch: "knox/b-branch" },
  ]);

  const { runner, calls } = happyRunner();
  const output = new PullRequestQueueOutput({ repoDir: "/repo" }, runner);
  const result = await output.deliver(report, manifest);

  assertEquals(result.prs?.length, 2);

  // Both PRs target main
  const createCalls = calls.filter(
    (c) => c.args[0] === "gh" && c.args[2] === "create",
  );
  assertEquals(createCalls.length, 2);

  for (const call of createCalls) {
    const baseIdx = call.args.indexOf("--base");
    assertEquals(call.args[baseIdx + 1], "main");
  }

  // PR for item a
  const prA = result.prs?.find((p) => p.itemId === "a");
  assertEquals(prA?.url, "https://github.com/org/repo/pull/1");
  assertEquals(prA?.number, 1);

  // PR for item b
  const prB = result.prs?.find((p) => p.itemId === "b");
  assertEquals(prB?.number, 2);
});

Deno.test("PullRequestQueueOutput — grouped items produce one PR per group", async () => {
  const manifest: QueueManifest = {
    items: [
      { id: "a", task: "Step 1", group: "feat-x" },
      { id: "b", task: "Step 2", group: "feat-x" },
      { id: "c", task: "Unrelated" },
    ],
  };
  // Grouped items share the same branch
  const sharedBranch = "knox/feat-x-run1";
  const report = makeReport([
    { id: "a", status: "completed", branch: sharedBranch },
    { id: "b", status: "completed", branch: sharedBranch },
    { id: "c", status: "completed", branch: "knox/c-branch" },
  ]);

  const { runner, calls } = happyRunner();
  const output = new PullRequestQueueOutput({ repoDir: "/repo" }, runner);
  const result = await output.deliver(report, manifest);

  const createCalls = calls.filter(
    (c) => c.args[0] === "gh" && c.args[2] === "create",
  );
  // Only 2 gh pr create calls: one for the group branch and one for c
  assertEquals(createCalls.length, 2);

  // Both a and b map to the same PR
  const prA = result.prs?.find((p) => p.itemId === "a");
  const prB = result.prs?.find((p) => p.itemId === "b");
  assertEquals(prA?.url, prB?.url);
  assertEquals(prA?.number, prB?.number);

  // 3 PR entries total (a, b, c)
  assertEquals(result.prs?.length, 3);
});

Deno.test("PullRequestQueueOutput — dependent items produce stacked PRs targeting dependency branch", async () => {
  const manifest: QueueManifest = {
    items: [
      { id: "base-item", task: "Base work" },
      { id: "stacked-item", task: "Stacked work", dependsOn: ["base-item"] },
    ],
  };
  const report = makeReport([
    { id: "base-item", status: "completed", branch: "knox/base-branch" },
    { id: "stacked-item", status: "completed", branch: "knox/stacked-branch" },
  ]);

  const { runner, calls } = happyRunner();
  const output = new PullRequestQueueOutput({ repoDir: "/repo" }, runner);
  const result = await output.deliver(report, manifest);

  const createCalls = calls.filter(
    (c) => c.args[0] === "gh" && c.args[2] === "create",
  );
  assertEquals(createCalls.length, 2);

  // Find the stacked PR create call
  const stackedCall = createCalls.find((c) => {
    const headIdx = c.args.indexOf("--head");
    return c.args[headIdx + 1] === "knox/stacked-branch";
  })!;

  const baseIdx = stackedCall.args.indexOf("--base");
  assertEquals(stackedCall.args[baseIdx + 1], "knox/base-branch");

  assertEquals(result.prs?.length, 2);
});

Deno.test("PullRequestQueueOutput — dependent PRs are always created as draft", async () => {
  const manifest: QueueManifest = {
    items: [
      { id: "a", task: "Base" },
      { id: "b", task: "Stacked", dependsOn: ["a"] },
    ],
  };
  const report = makeReport([
    { id: "a", status: "completed", branch: "knox/a" },
    { id: "b", status: "completed", branch: "knox/b" },
  ]);

  const { runner, calls } = happyRunner();
  // draft option NOT set on the output
  const output = new PullRequestQueueOutput(
    { repoDir: "/repo", draft: false },
    runner,
  );
  const result = await output.deliver(report, manifest);

  const createCalls = calls.filter(
    (c) => c.args[0] === "gh" && c.args[2] === "create",
  );

  // Base PR: not draft
  const baseCall = createCalls.find((c) => {
    const headIdx = c.args.indexOf("--head");
    return c.args[headIdx + 1] === "knox/a";
  })!;
  assertEquals(baseCall.args.includes("--draft"), false);

  // Stacked PR: forced to draft
  const stackedCall = createCalls.find((c) => {
    const headIdx = c.args.indexOf("--head");
    return c.args[headIdx + 1] === "knox/b";
  })!;
  assertEquals(stackedCall.args.includes("--draft"), true);

  // Result reflects draft status
  const prB = result.prs?.find((p) => p.itemId === "b");
  assertEquals(prB?.draft, true);
  const prA = result.prs?.find((p) => p.itemId === "a");
  assertEquals(prA?.draft, false);
});

Deno.test("PullRequestQueueOutput — PR body includes dependency callout for stacked PRs", async () => {
  const manifest: QueueManifest = {
    items: [
      { id: "a", task: "Base work" },
      { id: "b", task: "Stacked work", dependsOn: ["a"] },
    ],
  };
  const report = makeReport([
    { id: "a", status: "completed", branch: "knox/a" },
    { id: "b", status: "completed", branch: "knox/b" },
  ]);

  const { runner, calls } = happyRunner();
  const output = new PullRequestQueueOutput({ repoDir: "/repo" }, runner);
  await output.deliver(report, manifest);

  const createCalls = calls.filter(
    (c) => c.args[0] === "gh" && c.args[2] === "create",
  );

  // Base PR body has no dependency callout
  const baseCall = createCalls.find((c) => {
    const headIdx = c.args.indexOf("--head");
    return c.args[headIdx + 1] === "knox/a";
  })!;
  const baseBodyIdx = baseCall.args.indexOf("--body");
  const baseBody = baseCall.args[baseBodyIdx + 1];
  assertEquals(baseBody.includes("## Dependencies"), false);

  // Stacked PR body has dependency callout
  const stackedCall = createCalls.find((c) => {
    const headIdx = c.args.indexOf("--head");
    return c.args[headIdx + 1] === "knox/b";
  })!;
  const stackedBodyIdx = stackedCall.args.indexOf("--body");
  const stackedBody = stackedCall.args[stackedBodyIdx + 1];
  assertEquals(stackedBody.includes("## Dependencies"), true);
  assertEquals(stackedBody.includes("#1"), true); // PR number of base
  assertEquals(stackedBody.includes("Base work"), true);
  assertEquals(
    stackedBody.includes(
      "GitHub will automatically retarget this PR to `main`",
    ),
    true,
  );
});

Deno.test("PullRequestQueueOutput — failed and blocked items produce no PRs", async () => {
  const manifest: QueueManifest = {
    items: [
      { id: "a", task: "OK" },
      { id: "b", task: "Failed" },
      { id: "c", task: "Blocked", dependsOn: ["b"] },
    ],
  };
  const report = makeReport([
    { id: "a", status: "completed", branch: "knox/a" },
    { id: "b", status: "failed" },
    { id: "c", status: "blocked", blockedBy: "b" },
  ]);

  const { runner, calls } = happyRunner();
  const output = new PullRequestQueueOutput({ repoDir: "/repo" }, runner);
  const result = await output.deliver(report, manifest);

  const createCalls = calls.filter(
    (c) => c.args[0] === "gh" && c.args[2] === "create",
  );
  // Only one PR created (for item a)
  assertEquals(createCalls.length, 1);
  assertEquals(result.prs?.length, 1);
  assertEquals(result.prs?.[0].itemId, "a");
});

Deno.test("PullRequestQueueOutput — mixed queue computes all bases correctly", async () => {
  // independent + grouped + dependent
  const manifest: QueueManifest = {
    items: [
      { id: "solo", task: "Solo task" },
      { id: "g1", task: "Group step 1", group: "feat" },
      { id: "g2", task: "Group step 2", group: "feat" },
      { id: "dep", task: "Depends on solo", dependsOn: ["solo"] },
    ],
  };
  const groupBranch = "knox/feat-run1";
  const report = makeReport([
    { id: "solo", status: "completed", branch: "knox/solo" },
    { id: "g1", status: "completed", branch: groupBranch },
    { id: "g2", status: "completed", branch: groupBranch },
    { id: "dep", status: "completed", branch: "knox/dep" },
  ]);

  const { runner, calls } = happyRunner();
  const output = new PullRequestQueueOutput({ repoDir: "/repo" }, runner);
  const result = await output.deliver(report, manifest);

  const createCalls = calls.filter(
    (c) => c.args[0] === "gh" && c.args[2] === "create",
  );
  // solo, group (one), dep = 3 gh pr create calls
  assertEquals(createCalls.length, 3);

  const baseOf = (head: string): string => {
    const call = createCalls.find((c) => {
      const hi = c.args.indexOf("--head");
      return c.args[hi + 1] === head;
    })!;
    const bi = call.args.indexOf("--base");
    return call.args[bi + 1];
  };

  assertEquals(baseOf("knox/solo"), "main");
  assertEquals(baseOf(groupBranch), "main");
  assertEquals(baseOf("knox/dep"), "knox/solo"); // stacked on solo

  // dep is a draft (stacked)
  const depCall = createCalls.find((c) => {
    const hi = c.args.indexOf("--head");
    return c.args[hi + 1] === "knox/dep";
  })!;
  assertEquals(depCall.args.includes("--draft"), true);

  // g1 and g2 share the same PR
  const prG1 = result.prs?.find((p) => p.itemId === "g1");
  const prG2 = result.prs?.find((p) => p.itemId === "g2");
  assertEquals(prG1?.url, prG2?.url);

  assertEquals(result.prs?.length, 4); // solo, g1, g2 (shared), dep
});

Deno.test("PullRequestQueueOutput — missing gh CLI produces a clear preflight error", async () => {
  const { runner } = mockRunner((args) => {
    if (args.join(" ") === "gh auth status") {
      return {
        success: false,
        stdout: "",
        stderr: "command not found: gh",
        code: 127,
      };
    }
    return { success: true, stdout: "", stderr: "", code: 0 };
  });

  const output = new PullRequestQueueOutput({ repoDir: "/repo" }, runner);
  const manifest: QueueManifest = { items: [{ id: "a", task: "Task" }] };
  const report = makeReport([
    { id: "a", status: "completed", branch: "knox/a" },
  ]);

  await assertRejects(
    () => output.deliver(report, manifest),
    Error,
    "gh CLI is not available or not authenticated",
  );
});

Deno.test("PullRequestQueueOutput — existing PR for a branch is handled gracefully", async () => {
  const manifest: QueueManifest = {
    items: [{ id: "a", task: "Task A" }],
  };
  const report = makeReport([
    { id: "a", status: "completed", branch: "knox/a" },
  ]);

  // Make gh pr create return "already exists" for knox/a
  const existingPrResponses = new Map<string, RunnerResponse>([
    [
      "knox/a",
      {
        success: true,
        stdout: JSON.stringify({
          number: 55,
          url: "https://github.com/org/repo/pull/55",
        }),
        stderr: "",
        code: 0,
      },
    ],
  ]);
  const { runner } = happyRunner(new Map([["knox/a", "exists"]]), existingPrResponses);
  const output = new PullRequestQueueOutput({ repoDir: "/repo" }, runner);

  // Should not throw
  const result = await output.deliver(report, manifest);

  // Should include the existing PR's info
  assertEquals(result.prs?.length, 1);
  assertEquals(result.prs?.[0].number, 55);
  assertEquals(result.prs?.[0].url, "https://github.com/org/repo/pull/55");
});

Deno.test("PullRequestQueueOutput — labels and reviewers are passed to gh pr create", async () => {
  const manifest: QueueManifest = {
    items: [{ id: "a", task: "Task A" }],
  };
  const report = makeReport([
    { id: "a", status: "completed", branch: "knox/a" },
  ]);

  const { runner, calls } = happyRunner();
  const output = new PullRequestQueueOutput(
    {
      repoDir: "/repo",
      labels: ["bug", "enhancement"],
      reviewers: ["alice", "bob"],
    },
    runner,
  );

  await output.deliver(report, manifest);

  const createCall = calls.find(
    (c) => c.args[0] === "gh" && c.args[2] === "create",
  )!;

  // Labels
  const labelPairs: string[] = [];
  for (let i = 0; i < createCall.args.length; i++) {
    if (createCall.args[i] === "--label") {
      labelPairs.push(createCall.args[i + 1]);
    }
  }
  assertEquals(labelPairs, ["bug", "enhancement"]);

  // Reviewers
  const reviewerPairs: string[] = [];
  for (let i = 0; i < createCall.args.length; i++) {
    if (createCall.args[i] === "--reviewer") {
      reviewerPairs.push(createCall.args[i + 1]);
    }
  }
  assertEquals(reviewerPairs, ["alice", "bob"]);
});

Deno.test("PullRequestQueueOutput — draft option forces all PRs to draft", async () => {
  const manifest: QueueManifest = {
    items: [
      { id: "a", task: "Task A" },
      { id: "b", task: "Task B" },
    ],
  };
  const report = makeReport([
    { id: "a", status: "completed", branch: "knox/a" },
    { id: "b", status: "completed", branch: "knox/b" },
  ]);

  const { runner, calls } = happyRunner();
  const output = new PullRequestQueueOutput(
    { repoDir: "/repo", draft: true },
    runner,
  );

  const result = await output.deliver(report, manifest);

  const createCalls = calls.filter(
    (c) => c.args[0] === "gh" && c.args[2] === "create",
  );
  for (const call of createCalls) {
    assertEquals(call.args.includes("--draft"), true);
  }

  for (const pr of result.prs ?? []) {
    assertEquals(pr.draft, true);
  }
});

Deno.test("PullRequestQueueOutput — auto-detects default branch from git", async () => {
  const manifest: QueueManifest = {
    items: [{ id: "a", task: "Task" }],
  };
  const report = makeReport([
    { id: "a", status: "completed", branch: "knox/a" },
  ]);

  const { runner, calls } = mockRunner((args) => {
    const cmd = args.join(" ");
    if (cmd === "gh auth status") {
      return { success: true, stdout: "", stderr: "", code: 0 };
    }
    if (cmd === "git symbolic-ref refs/remotes/origin/HEAD") {
      return {
        success: true,
        stdout: "refs/remotes/origin/develop",
        stderr: "",
        code: 0,
      };
    }
    if (args[0] === "gh" && args[2] === "create") {
      return {
        success: true,
        stdout: "https://github.com/org/repo/pull/1",
        stderr: "",
        code: 0,
      };
    }
    return { success: false, stdout: "", stderr: "unexpected", code: 1 };
  });

  const output = new PullRequestQueueOutput({ repoDir: "/repo" }, runner);
  await output.deliver(report, manifest);

  const createCall = calls.find(
    (c) => c.args[0] === "gh" && c.args[2] === "create",
  )!;
  const baseIdx = createCall.args.indexOf("--base");
  assertEquals(createCall.args[baseIdx + 1], "develop");
});

Deno.test("PullRequestQueueOutput — baseBranch option skips git detection", async () => {
  const manifest: QueueManifest = {
    items: [{ id: "a", task: "Task" }],
  };
  const report = makeReport([
    { id: "a", status: "completed", branch: "knox/a" },
  ]);

  const { runner, calls } = happyRunner();
  const output = new PullRequestQueueOutput(
    { repoDir: "/repo", baseBranch: "production" },
    runner,
  );
  await output.deliver(report, manifest);

  // git symbolic-ref should NOT be called
  const gitCalls = calls.filter(
    (c) => c.args[0] === "git" && c.args[1] === "symbolic-ref",
  );
  assertEquals(gitCalls.length, 0);

  const createCall = calls.find(
    (c) => c.args[0] === "gh" && c.args[2] === "create",
  )!;
  const baseIdx = createCall.args.indexOf("--base");
  assertEquals(createCall.args[baseIdx + 1], "production");
});

Deno.test("PullRequestQueueOutput — dependent item on grouped dependency uses group branch as base", async () => {
  const manifest: QueueManifest = {
    items: [
      { id: "g1", task: "Group step 1", group: "feat" },
      { id: "g2", task: "Group step 2", group: "feat" },
      { id: "dep", task: "Depends on group", dependsOn: ["g1"] },
    ],
  };
  const groupBranch = "knox/feat-run1";
  const report = makeReport([
    { id: "g1", status: "completed", branch: groupBranch },
    { id: "g2", status: "completed", branch: groupBranch },
    { id: "dep", status: "completed", branch: "knox/dep" },
  ]);

  const { runner, calls } = happyRunner();
  const output = new PullRequestQueueOutput({ repoDir: "/repo" }, runner);
  await output.deliver(report, manifest);

  const createCalls = calls.filter(
    (c) => c.args[0] === "gh" && c.args[2] === "create",
  );

  const depCall = createCalls.find((c) => {
    const hi = c.args.indexOf("--head");
    return c.args[hi + 1] === "knox/dep";
  })!;
  const bi = depCall.args.indexOf("--base");
  assertEquals(depCall.args[bi + 1], groupBranch);
});
