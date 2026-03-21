import type { ContainerRuntime } from "../runtime/container_runtime.ts";

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

    // Check API key
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    const envHasKey = options.envVars.some((e) =>
      e.startsWith("ANTHROPIC_API_KEY=")
    );
    if (!apiKey && !envHasKey) {
      errors.push(
        "ANTHROPIC_API_KEY is not set. Set it via environment variable or --env ANTHROPIC_API_KEY=<key>.",
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
