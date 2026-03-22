import type { ContainerRuntime } from "../runtime/container_runtime.ts";
import { getCredential } from "../auth/mod.ts";

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export class PreflightChecker {
  async check(options: {
    runtime: ContainerRuntime;
    sourceDir: string;
    envVars: string[];
  }): Promise<PreflightResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check container runtime
    try {
      const result = await options.runtime.exec("__preflight__", ["echo", "ok"]);
      // This will always fail since the container doesn't exist, but we actually
      // need to check if docker itself is available
      void result;
    } catch {
      // Expected to fail — we need a different approach
    }

    // Check Docker is available by trying to run docker info
    const dockerOk = await this.checkDocker();
    if (!dockerOk) {
      errors.push(
        "Docker is not available. Ensure Docker is installed and running.",
      );
    }

    // Check authentication
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    const envHasKey = options.envVars.some((e) =>
      e.startsWith("ANTHROPIC_API_KEY=")
    );
    const envHasOauth = options.envVars.some((e) =>
      e.startsWith("CLAUDE_CODE_OAUTH_TOKEN=")
    );

    let hasOauthCredential = false;
    if (!apiKey && !envHasKey && !envHasOauth) {
      try {
        await getCredential();
        hasOauthCredential = true;
      } catch {
        hasOauthCredential = false;
      }
    }

    if (!apiKey && !envHasKey && !envHasOauth && !hasOauthCredential) {
      errors.push(
        "No authentication found. Set ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or log in with Claude Code.",
      );
    }

    // Check source directory exists
    try {
      const stat = await Deno.stat(options.sourceDir);
      if (!stat.isDirectory) {
        errors.push(`Source path is not a directory: ${options.sourceDir}`);
      }
    } catch {
      errors.push(`Source directory does not exist: ${options.sourceDir}`);
    }

    // Check if source dir is a git repo
    const isGit = await this.isGitRepo(options.sourceDir);
    if (!isGit) {
      warnings.push(
        `Source directory is not a git repository. Results will be copied to an output directory instead of a git branch.`,
      );
    } else {
      // Check for dirty working tree
      const isDirty = await this.isDirtyTree(options.sourceDir);
      if (isDirty) {
        warnings.push(
          "Working tree has uncommitted changes. Only committed state will be sent to the agent.",
        );
      }
    }

    return {
      ok: errors.length === 0,
      errors,
      warnings,
    };
  }

  private async checkDocker(): Promise<boolean> {
    try {
      const cmd = new Deno.Command("docker", {
        args: ["info"],
        stdout: "piped",
        stderr: "piped",
      });
      const result = await cmd.output();
      return result.code === 0;
    } catch {
      return false;
    }
  }

  private async isDirtyTree(dir: string): Promise<boolean> {
    try {
      const cmd = new Deno.Command("git", {
        args: ["status", "--porcelain"],
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      });
      const result = await cmd.output();
      if (result.code !== 0) return false;
      return new TextDecoder().decode(result.stdout).trim().length > 0;
    } catch {
      return false;
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
}
