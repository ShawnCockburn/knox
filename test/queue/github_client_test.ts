import { assertEquals, assertRejects } from "@std/assert";
import { GitHubClient, KNOX_LABELS } from "../../src/queue/github_client.ts";
import type { CommandRunner } from "../../src/queue/output/pr_queue_output.ts";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("GitHubClient — checkAuth succeeds when gh auth status succeeds", async () => {
  const { runner } = mockRunner(() => ({
    success: true,
    stdout: "Logged in",
    stderr: "",
    code: 0,
  }));
  const client = new GitHubClient("/repo", runner);
  await client.checkAuth(); // should not throw
});

Deno.test("GitHubClient — checkAuth throws when gh auth status fails", async () => {
  const { runner } = mockRunner(() => ({
    success: false,
    stdout: "",
    stderr: "not logged in",
    code: 1,
  }));
  const client = new GitHubClient("/repo", runner);
  await assertRejects(
    () => client.checkAuth(),
    Error,
    "gh CLI is not available or not authenticated",
  );
});

Deno.test("GitHubClient — listIssues calls gh issue list with correct args", async () => {
  const issues = [
    {
      number: 1,
      title: "Test issue",
      body: "body",
      author: { login: "user" },
      labels: [{ name: "agent/knox" }],
    },
  ];
  const { runner, calls } = mockRunner((args) => {
    if (args[1] === "issue" && args[2] === "list") {
      return {
        success: true,
        stdout: JSON.stringify(issues),
        stderr: "",
        code: 0,
      };
    }
    return { success: false, stdout: "", stderr: "unexpected", code: 1 };
  });
  const client = new GitHubClient("/repo", runner);
  const result = await client.listIssues();

  assertEquals(result.length, 1);
  assertEquals(result[0].number, 1);
  assertEquals(result[0].title, "Test issue");

  // Verify correct args were passed
  const listCall = calls.find((c) => c.args[1] === "issue" && c.args[2] === "list")!;
  assertEquals(listCall.args.includes("--label"), true);
  assertEquals(listCall.args.includes("agent/knox"), true);
  assertEquals(listCall.args.includes("--state"), true);
  assertEquals(listCall.args.includes("open"), true);
  assertEquals(listCall.cwd, "/repo");
});

Deno.test("GitHubClient — listIssues throws on failure", async () => {
  const { runner } = mockRunner(() => ({
    success: false,
    stdout: "",
    stderr: "API error",
    code: 1,
  }));
  const client = new GitHubClient("/repo", runner);
  await assertRejects(() => client.listIssues(), Error, "Failed to list issues");
});

Deno.test("GitHubClient — addLabel calls gh issue edit with --add-label", async () => {
  const { runner, calls } = mockRunner(() => ({
    success: true,
    stdout: "",
    stderr: "",
    code: 0,
  }));
  const client = new GitHubClient("/repo", runner);
  await client.addLabel(42, "knox/claimed");

  const call = calls[0];
  assertEquals(call.args, [
    "gh",
    "issue",
    "edit",
    "42",
    "--add-label",
    "knox/claimed",
  ]);
});

Deno.test("GitHubClient — removeLabel calls gh issue edit with --remove-label", async () => {
  const { runner, calls } = mockRunner(() => ({
    success: true,
    stdout: "",
    stderr: "",
    code: 0,
  }));
  const client = new GitHubClient("/repo", runner);
  await client.removeLabel(42, "knox/claimed");

  const call = calls[0];
  assertEquals(call.args, [
    "gh",
    "issue",
    "edit",
    "42",
    "--remove-label",
    "knox/claimed",
  ]);
});

Deno.test("GitHubClient — removeLabel ignores 'not found' errors", async () => {
  const { runner } = mockRunner(() => ({
    success: false,
    stdout: "",
    stderr: "label 'knox/claimed' not found",
    code: 1,
  }));
  const client = new GitHubClient("/repo", runner);
  // Should not throw
  await client.removeLabel(42, "knox/claimed");
});

Deno.test("GitHubClient — closeIssue calls gh issue close", async () => {
  const { runner, calls } = mockRunner(() => ({
    success: true,
    stdout: "",
    stderr: "",
    code: 0,
  }));
  const client = new GitHubClient("/repo", runner);
  await client.closeIssue(42);

  assertEquals(calls[0].args, ["gh", "issue", "close", "42"]);
});

Deno.test("GitHubClient — closeIssue throws on failure", async () => {
  const { runner } = mockRunner(() => ({
    success: false,
    stdout: "",
    stderr: "permission denied",
    code: 1,
  }));
  const client = new GitHubClient("/repo", runner);
  await assertRejects(
    () => client.closeIssue(42),
    Error,
    "Failed to close issue #42",
  );
});

Deno.test("GitHubClient — ensureLabels creates all knox labels with --force", async () => {
  const { runner, calls } = mockRunner(() => ({
    success: true,
    stdout: "",
    stderr: "",
    code: 0,
  }));
  const client = new GitHubClient("/repo", runner);
  await client.ensureLabels();

  assertEquals(calls.length, KNOX_LABELS.length);
  for (let i = 0; i < KNOX_LABELS.length; i++) {
    assertEquals(calls[i].args[1], "label");
    assertEquals(calls[i].args[2], "create");
    assertEquals(calls[i].args[3], KNOX_LABELS[i]);
    assertEquals(calls[i].args.includes("--force"), true);
  }
});
