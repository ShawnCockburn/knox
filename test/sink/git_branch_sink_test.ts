import { assertEquals, assertRejects } from "@std/assert";
import { GitBranchSink } from "../../src/engine/sink/git_branch_sink.ts";
import { SourceStrategy } from "../../src/engine/source/source_provider.ts";
import { SinkStrategy } from "../../src/engine/sink/result_sink.ts";
import type { SourceMetadata } from "../../src/engine/source/source_provider.ts";

async function git(cwd: string, args: string[]): Promise<string> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  if (result.code !== 0) {
    throw new Error(
      `git ${args[0]} failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

/**
 * Creates a "host" repo and a clone that simulates the agent workspace.
 * Makes a commit in the clone, creates a bundle, and returns everything
 * needed to test the sink.
 */
async function setupBundleScenario(): Promise<{
  hostRepo: string;
  cloneDir: string;
  bundlePath: string;
  baseCommit: string;
  metadata: SourceMetadata;
}> {
  // Create host repo
  const hostRepo = await Deno.makeTempDir({ prefix: "knox-host-" });
  await git(hostRepo, ["init"]);
  await git(hostRepo, ["config", "user.email", "test@test.com"]);
  await git(hostRepo, ["config", "user.name", "Test"]);
  await Deno.writeTextFile(`${hostRepo}/README.md`, "# Host\n");
  await git(hostRepo, ["add", "-A"]);
  await git(hostRepo, ["commit", "-m", "initial"]);
  const baseCommit = await git(hostRepo, ["rev-parse", "HEAD"]);

  // Clone (simulates what GitSourceProvider does)
  const cloneDir = await Deno.makeTempDir({ prefix: "knox-clone-" });
  await Deno.remove(cloneDir); // git clone needs target not to exist
  await git(hostRepo, [
    "clone",
    "--depth",
    "1",
    `file://${hostRepo}`,
    cloneDir,
  ]);
  await git(cloneDir, ["config", "user.email", "agent@knox.dev"]);
  await git(cloneDir, ["config", "user.name", "Knox Agent"]);

  // Simulate agent work: add a file and commit
  await Deno.writeTextFile(
    `${cloneDir}/agent-work.ts`,
    "export const x = 42;\n",
  );
  await git(cloneDir, ["add", "-A"]);
  await git(cloneDir, ["commit", "-m", "feat: add agent work"]);

  // Create bundle
  const bundlePath = `${cloneDir}/result.bundle`;
  await git(cloneDir, ["bundle", "create", bundlePath, "HEAD"]);

  const metadata: SourceMetadata = {
    strategy: SourceStrategy.HostGit,
    baseCommit,
    repoPath: hostRepo,
  };

  return { hostRepo, cloneDir, bundlePath, baseCommit, metadata };
}

Deno.test("GitBranchSink", async (t) => {
  await t.step(
    "collect() creates branch without switching host checkout",
    async () => {
      const { hostRepo, cloneDir, bundlePath, metadata } =
        await setupBundleScenario();
      try {
        const originalBranch = await git(hostRepo, [
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ]);

        const sink = new GitBranchSink(hostRepo);
        await sink.collect({
          runId: "aabb1122",
          bundlePath,
          metadata,
          taskSlug: "add-agent-work",
          autoCommitted: false,
        });

        // Host checkout should not have changed
        const currentBranch = await git(hostRepo, [
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ]);
        assertEquals(currentBranch, originalBranch);
      } finally {
        await Deno.remove(hostRepo, { recursive: true });
        await Deno.remove(cloneDir, { recursive: true });
      }
    },
  );

  await t.step("collect() returns correct commit count", async () => {
    const { hostRepo, cloneDir, bundlePath, metadata } =
      await setupBundleScenario();
    try {
      const sink = new GitBranchSink(hostRepo);
      const result = await sink.collect({
        runId: "cc001122",
        bundlePath,
        metadata,
        taskSlug: "test-task",
        autoCommitted: false,
      });
      assertEquals(result.commitCount, 1);
    } finally {
      await Deno.remove(hostRepo, { recursive: true });
      await Deno.remove(cloneDir, { recursive: true });
    }
  });

  await t.step("collect() uses correct branch name format", async () => {
    const { hostRepo, cloneDir, bundlePath, metadata } =
      await setupBundleScenario();
    try {
      const sink = new GitBranchSink(hostRepo);
      const result = await sink.collect({
        runId: "dd334455",
        bundlePath,
        metadata,
        taskSlug: "my-feature",
        autoCommitted: false,
      });
      assertEquals(result.strategy, SinkStrategy.HostGit);
      assertEquals(result.branchName, "knox/my-feature-dd334455");
      assertEquals(result.autoCommitted, false);
    } finally {
      await Deno.remove(hostRepo, { recursive: true });
      await Deno.remove(cloneDir, { recursive: true });
    }
  });

  await t.step(
    "collect() throws on missing bundle file",
    async () => {
      const hostRepo = await Deno.makeTempDir({ prefix: "knox-host-" });
      await git(hostRepo, ["init"]);
      await git(hostRepo, ["config", "user.email", "test@test.com"]);
      await git(hostRepo, ["config", "user.name", "Test"]);
      await Deno.writeTextFile(`${hostRepo}/README.md`, "# Host\n");
      await git(hostRepo, ["add", "-A"]);
      await git(hostRepo, ["commit", "-m", "initial"]);

      try {
        const sink = new GitBranchSink(hostRepo);
        await assertRejects(
          () =>
            sink.collect({
              runId: "missing1",
              bundlePath: "/tmp/does-not-exist.bundle",
              metadata: {
                strategy: SourceStrategy.HostGit,
                baseCommit: "abc",
                repoPath: hostRepo,
              },
              taskSlug: "test",
              autoCommitted: false,
            }),
          Error,
          "Bundle file not found",
        );
      } finally {
        await Deno.remove(hostRepo, { recursive: true });
      }
    },
  );

  await t.step("collect() passes through autoCommitted flag", async () => {
    const { hostRepo, cloneDir, bundlePath, metadata } =
      await setupBundleScenario();
    try {
      const sink = new GitBranchSink(hostRepo);
      const result = await sink.collect({
        runId: "auto0001",
        bundlePath,
        metadata,
        taskSlug: "auto-test",
        autoCommitted: true,
      });
      assertEquals(result.autoCommitted, true);
    } finally {
      await Deno.remove(hostRepo, { recursive: true });
      await Deno.remove(cloneDir, { recursive: true });
    }
  });
});
