import {
  type CollectOptions,
  type ResultSink,
  type SinkResult,
  SinkStrategy,
} from "./result_sink.ts";

/**
 * Creates a branch on the host repo from a git bundle.
 *
 * Uses `git fetch` from the bundle — no checkout switch, no patch conflicts.
 */
export class GitBranchSink implements ResultSink {
  constructor(private readonly repoPath: string) {}

  async collect(options: CollectOptions): Promise<SinkResult> {
    const { runId, bundlePath, metadata, taskSlug, autoCommitted } = options;

    // Verify bundle exists
    try {
      await Deno.stat(bundlePath);
    } catch {
      throw new Error(`Bundle file not found: ${bundlePath}`);
    }

    // Use override or compute branch name
    const branchName = options.branchName ?? `knox/${taskSlug}-${runId}`;

    // Fetch bundle into host repo as a new branch (no checkout switch)
    await this.gitRun([
      "fetch",
      bundlePath,
      `HEAD:refs/heads/${branchName}`,
    ]);

    // Count commits since base
    const countOutput = await this.gitOutput([
      "rev-list",
      "--count",
      `${metadata.baseCommit}..${branchName}`,
    ]);
    const commitCount = parseInt(countOutput, 10);

    return {
      strategy: SinkStrategy.HostGit,
      branchName,
      commitCount,
      autoCommitted,
    };
  }

  async cleanup(_runId: string): Promise<void> {
    // No-op for HostGit — the branch is the result.
  }

  private async gitRun(args: string[]): Promise<void> {
    const cmd = new Deno.Command("git", {
      args,
      cwd: this.repoPath,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    if (result.code !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`git ${args[0]} failed: ${stderr}`);
    }
  }

  private async gitOutput(args: string[]): Promise<string> {
    const cmd = new Deno.Command("git", {
      args,
      cwd: this.repoPath,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    if (result.code !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`git ${args[0]} failed: ${stderr}`);
    }
    return new TextDecoder().decode(result.stdout).trim();
  }
}
