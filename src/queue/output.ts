import type { QueueReport } from "./orchestrator.ts";
import { log } from "../shared/log.ts";

/** Post-run output strategy for a completed queue. */
export interface QueueOutput {
  onQueueComplete(report: QueueReport): Promise<void>;
}

/**
 * Default output: branches are created by the engine sink.
 * No additional action required.
 */
export class BranchQueueOutput implements QueueOutput {
  async onQueueComplete(_report: QueueReport): Promise<void> {
    // No-op: branch creation is handled by the result sink in Knox engine
  }
}

/** Options for pull-request creation. */
export interface PullRequestOptions {
  draft?: boolean;
  base?: string;
  repoDir?: string;
}

/**
 * Creates a GitHub PR for each completed queue item branch via the `gh` CLI.
 */
export class PullRequestQueueOutput implements QueueOutput {
  constructor(private readonly options: PullRequestOptions = {}) {}

  async onQueueComplete(report: QueueReport): Promise<void> {
    const completed = report.items.filter(
      (i) => i.status === "completed" && i.branch,
    );

    if (completed.length === 0) {
      log.info("No completed branches to create PRs for.");
      return;
    }

    const seen = new Set<string>();
    for (const item of completed) {
      const branch = item.branch!;
      if (seen.has(branch)) continue;
      seen.add(branch);
      await this.createPR(item.id, branch);
    }
  }

  private async createPR(itemId: string, branch: string): Promise<void> {
    const repoDir = this.options.repoDir;
    const pushCmd = new Deno.Command("git", {
      args: ["push", "origin", branch],
      ...(repoDir ? { cwd: repoDir } : {}),
      stdout: "piped",
      stderr: "piped",
    });
    const pushResult = await pushCmd.output();
    if (!pushResult.success) {
      const err = new TextDecoder().decode(pushResult.stderr).trim();
      log.error(`Failed to push branch '${branch}': ${err}`);
      return;
    }

    const args = [
      "pr",
      "create",
      "--head",
      branch,
      "--title",
      `[knox] ${itemId}`,
      "--body",
      `Automated PR from knox queue item: ${itemId}`,
    ];
    if (this.options.draft) args.push("--draft");
    if (this.options.base) args.push("--base", this.options.base);

    try {
      const cmd = new Deno.Command("gh", {
        args,
        stdout: "piped",
        stderr: "piped",
      });
      const result = await cmd.output();
      if (result.success) {
        const url = new TextDecoder().decode(result.stdout).trim();
        log.always(`PR created for ${itemId}: ${url}`);
      } else {
        const err = new TextDecoder().decode(result.stderr).trim();
        log.error(`Failed to create PR for ${branch}: ${err}`);
      }
    } catch (e) {
      log.error(
        `Failed to create PR for ${branch}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}

/**
 * Create a single PR for a given branch (used by `knox run --output pr`).
 */
export async function createSinglePR(
  branch: string,
  taskTitle: string,
  options: PullRequestOptions = {},
): Promise<void> {
  const args = [
    "pr",
    "create",
    "--head",
    branch,
    "--title",
    `[knox] ${taskTitle.slice(0, 72)}`,
    "--body",
    `Automated PR from knox run.\n\nTask: ${taskTitle}`,
  ];
  if (options.draft) args.push("--draft");
  if (options.base) args.push("--base", options.base);

  try {
    const cmd = new Deno.Command("gh", {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    if (result.success) {
      const url = new TextDecoder().decode(result.stdout).trim();
      log.always(`PR created: ${url}`);
    } else {
      const err = new TextDecoder().decode(result.stderr).trim();
      log.error(`Failed to create PR for ${branch}: ${err}`);
    }
  } catch (e) {
    log.error(
      `Failed to create PR for ${branch}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}
