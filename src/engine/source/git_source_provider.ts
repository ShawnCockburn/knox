import {
  type PrepareResult,
  type SourceProvider,
  SourceStrategy,
} from "./source_provider.ts";

const TMP_BASE = "/tmp";

/**
 * Prepares source via a depth-1 clone of a local git repo.
 *
 * Security: only committed state at HEAD is cloned — history
 * (which may contain reverted secrets) never reaches the agent.
 */
export class GitSourceProvider implements SourceProvider {
  constructor(
    private readonly repoPath: string,
    private readonly ref?: string,
  ) {}

  async prepare(runId: string): Promise<PrepareResult> {
    const warnings: string[] = [];

    // Record base commit
    const baseCommit = await this.gitOutput(["rev-parse", "HEAD"]);

    // Warn on dirty working tree
    const porcelain = await this.gitOutput(["status", "--porcelain"]);
    if (porcelain.length > 0) {
      warnings.push(
        "Working tree has uncommitted changes. Only committed state will be sent to the agent.",
      );
    }

    // Shallow clone into run temp directory
    const hostPath = `${TMP_BASE}/knox-${runId}/source`;
    const cloneArgs = ["clone", "--depth", "1"];
    if (this.ref) {
      cloneArgs.push("--branch", this.ref);
    }
    cloneArgs.push(`file://${this.repoPath}`, hostPath);

    const clone = new Deno.Command("git", {
      args: cloneArgs,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await clone.output();
    if (result.code !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`git clone failed: ${stderr}`);
    }

    return {
      hostPath,
      metadata: {
        strategy: SourceStrategy.HostGit,
        baseCommit,
        repoPath: this.repoPath,
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  async cleanup(runId: string): Promise<void> {
    const dir = `${TMP_BASE}/knox-${runId}/source`;
    try {
      await Deno.remove(dir, { recursive: true });
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
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
