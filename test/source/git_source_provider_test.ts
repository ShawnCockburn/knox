import { assertEquals, assertRejects } from "@std/assert";
import { GitSourceProvider } from "../../src/engine/source/git_source_provider.ts";
import { SourceStrategy } from "../../src/engine/source/source_provider.ts";

/** Create a temp git repo with an initial commit. Returns the repo path. */
async function createTempRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "knox-test-" });
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "test@test.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await Deno.writeTextFile(`${dir}/README.md`, "# Test\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "initial"]);
  return dir;
}

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

Deno.test("GitSourceProvider", async (t) => {
  await t.step("prepare() creates a shallow clone at depth 1", async () => {
    const repo = await createTempRepo();
    // Add more commits so we can verify shallow clone depth
    await Deno.writeTextFile(`${repo}/file1.ts`, "export const a = 1;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "second"]);
    await Deno.writeTextFile(`${repo}/file2.ts`, "export const b = 2;\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "third"]);

    const runId = "aabbccdd";
    const provider = new GitSourceProvider(repo);
    try {
      const result = await provider.prepare(runId);
      // Verify shallow: only 1 commit in clone
      const count = await git(result.hostPath, [
        "rev-list",
        "--count",
        "HEAD",
      ]);
      assertEquals(count, "1");
    } finally {
      await provider.cleanup(runId);
      await Deno.remove(repo, { recursive: true });
    }
  });

  await t.step("prepare() records correct baseCommit", async () => {
    const repo = await createTempRepo();
    const runId = "11223344";
    const provider = new GitSourceProvider(repo);
    try {
      const headSha = await git(repo, ["rev-parse", "HEAD"]);
      const result = await provider.prepare(runId);
      assertEquals(result.metadata.strategy, SourceStrategy.HostGit);
      assertEquals(result.metadata.baseCommit, headSha);
      assertEquals(result.metadata.repoPath, repo);
    } finally {
      await provider.cleanup(runId);
      await Deno.remove(repo, { recursive: true });
    }
  });

  await t.step("prepare() warns on dirty working tree", async () => {
    const repo = await createTempRepo();
    // Create an untracked file to make the tree dirty
    await Deno.writeTextFile(`${repo}/dirty.txt`, "uncommitted\n");
    const runId = "dirty001";
    const provider = new GitSourceProvider(repo);
    try {
      const result = await provider.prepare(runId);
      assertEquals(result.warnings?.length, 1);
      assertEquals(
        result.warnings![0].includes("uncommitted"),
        true,
      );
    } finally {
      await provider.cleanup(runId);
      await Deno.remove(repo, { recursive: true });
    }
  });

  await t.step("prepare() does not warn on clean tree", async () => {
    const repo = await createTempRepo();
    const runId = "clean001";
    const provider = new GitSourceProvider(repo);
    try {
      const result = await provider.prepare(runId);
      assertEquals(result.warnings, undefined);
    } finally {
      await provider.cleanup(runId);
      await Deno.remove(repo, { recursive: true });
    }
  });

  await t.step("cleanup() removes source directory", async () => {
    const repo = await createTempRepo();
    const runId = "clean002";
    const provider = new GitSourceProvider(repo);
    try {
      const result = await provider.prepare(runId);
      // Verify dir exists
      const stat = await Deno.stat(result.hostPath);
      assertEquals(stat.isDirectory, true);
      // Cleanup
      await provider.cleanup(runId);
      // Verify dir is gone
      await assertRejects(
        () => Deno.stat(result.hostPath),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(repo, { recursive: true });
      // Extra cleanup in case test failed before cleanup()
      await Deno.remove(`/tmp/knox-${runId}`, { recursive: true }).catch(
        () => {},
      );
    }
  });

  await t.step("cleanup() is idempotent", async () => {
    const repo = await createTempRepo();
    const runId = "idempot1";
    const provider = new GitSourceProvider(repo);
    try {
      await provider.prepare(runId);
      await provider.cleanup(runId);
      // Second cleanup should not throw
      await provider.cleanup(runId);
    } finally {
      await Deno.remove(repo, { recursive: true });
    }
  });
});
