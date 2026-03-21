import type { ContainerRuntime } from "../runtime/container_runtime.ts";
import type { ContainerId } from "../types.ts";

export interface ExtractOptions {
  runtime: ContainerRuntime;
  containerId: ContainerId;
  hostDir: string;
  taskSlug: string;
  initialCommit: string;
}

export interface ExtractResult {
  branchName: string;
  commitCount: number;
  fallbackCopy: boolean;
}

export class ResultExtractor {
  /** Extract the agent's work as a git branch on the host. */
  async extract(options: ExtractOptions): Promise<ExtractResult> {
    const { runtime, containerId, hostDir, taskSlug, initialCommit } = options;

    // Check if host dir is a git repo
    const isGitRepo = await this.isGitRepo(hostDir);
    if (!isGitRepo) {
      return await this.fallbackCopy(runtime, containerId, hostDir, taskSlug);
    }

    // Get commits made by the agent
    const logResult = await runtime.exec(
      containerId,
      ["git", "log", "--oneline", `${initialCommit}..HEAD`],
      { workdir: "/workspace" },
    );

    const commitCount = logResult.stdout.trim()
      ? logResult.stdout.trim().split("\n").length
      : 0;

    if (commitCount === 0) {
      const branchName = `knox/${taskSlug}`;
      return { branchName, commitCount: 0, fallbackCopy: false };
    }

    // Generate patches from the agent's commits
    const patchResult = await runtime.exec(
      containerId,
      ["git", "format-patch", `${initialCommit}..HEAD`, "--stdout"],
      { workdir: "/workspace" },
    );

    if (patchResult.exitCode !== 0) {
      return await this.fallbackCopy(runtime, containerId, hostDir, taskSlug);
    }

    // Write patches to a temp file on host
    const patchFile = await Deno.makeTempFile({ suffix: ".patch" });
    try {
      await Deno.writeTextFile(patchFile, patchResult.stdout);

      // Create the branch on the host
      const branchName = await this.createBranch(hostDir, taskSlug);

      // Apply patches
      const am = new Deno.Command("git", {
        args: ["am", patchFile],
        cwd: hostDir,
        stdout: "piped",
        stderr: "piped",
      });
      const amResult = await am.output();

      if (amResult.code !== 0) {
        // Abort the failed am and fall back
        const abort = new Deno.Command("git", {
          args: ["am", "--abort"],
          cwd: hostDir,
          stdout: "piped",
          stderr: "piped",
        });
        await abort.output();
        return await this.fallbackCopy(runtime, containerId, hostDir, taskSlug);
      }

      // Switch back to the original branch
      const origBranch = await this.getCurrentBranch(hostDir);
      if (origBranch !== branchName) {
        // We're already on the new branch after git am, switch back handled by caller
      }

      return { branchName, commitCount, fallbackCopy: false };
    } finally {
      await Deno.remove(patchFile).catch(() => {});
    }
  }

  private async isGitRepo(dir: string): Promise<boolean> {
    try {
      const cmd = new Deno.Command("git", {
        args: ["rev-parse", "--git-dir"],
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      });
      const result = await cmd.output();
      return result.code === 0;
    } catch {
      return false;
    }
  }

  private async getCurrentBranch(dir: string): Promise<string> {
    const cmd = new Deno.Command("git", {
      args: ["rev-parse", "--abbrev-ref", "HEAD"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    return new TextDecoder().decode(result.stdout).trim();
  }

  private async createBranch(
    dir: string,
    taskSlug: string,
  ): Promise<string> {
    let branchName = `knox/${taskSlug}`;
    let suffix = 0;

    while (await this.branchExists(dir, branchName)) {
      suffix++;
      branchName = `knox/${taskSlug}-${suffix}`;
    }

    const cmd = new Deno.Command("git", {
      args: ["checkout", "-b", branchName],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    if (result.code !== 0) {
      throw new Error(
        `Failed to create branch ${branchName}: ${new TextDecoder().decode(result.stderr)}`,
      );
    }

    return branchName;
  }

  private async branchExists(dir: string, name: string): Promise<boolean> {
    const cmd = new Deno.Command("git", {
      args: ["rev-parse", "--verify", name],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    return result.code === 0;
  }

  private async fallbackCopy(
    runtime: ContainerRuntime,
    containerId: ContainerId,
    hostDir: string,
    taskSlug: string,
  ): Promise<ExtractResult> {
    const outputDir = `${hostDir}/knox-output-${taskSlug}`;
    await Deno.mkdir(outputDir, { recursive: true });
    await runtime.copyOut(containerId, "/workspace/.", outputDir);
    return {
      branchName: outputDir,
      commitCount: 0,
      fallbackCopy: true,
    };
  }
}

/** Generate a URL-safe slug from a task description. */
export function taskSlug(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}
