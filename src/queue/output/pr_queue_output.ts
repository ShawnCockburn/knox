import type { QueueManifest } from "../types.ts";
import type { QueueReport } from "../orchestrator.ts";
import type { QueueOutput, QueueOutputResult } from "./queue_output.ts";
import { log } from "../../shared/log.ts";

export interface PullRequestOutputOptions {
  repoDir: string;
  baseBranch?: string;
  draft?: boolean;
  labels?: string[];
  reviewers?: string[];
}

export type CommandRunner = (
  args: string[],
  cwd: string,
) => Promise<
  { success: boolean; stdout: string; stderr: string; code: number }
>;

export async function defaultCommandRunner(
  args: string[],
  cwd: string,
): Promise<{ success: boolean; stdout: string; stderr: string; code: number }> {
  const cmd = new Deno.Command(args[0], {
    args: args.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  return {
    success: output.success,
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
}

interface PrCreated {
  url: string;
  number: number;
  title: string;
}

export class PullRequestQueueOutput implements QueueOutput {
  private readonly options: PullRequestOutputOptions;
  private readonly runner: CommandRunner;

  constructor(options: PullRequestOutputOptions, runner?: CommandRunner) {
    this.options = options;
    this.runner = runner ?? defaultCommandRunner;
  }

  async deliver(
    report: QueueReport,
    manifest: QueueManifest,
  ): Promise<QueueOutputResult> {
    await this.preflight();

    const { repoDir } = this.options;
    const defaultBranch = this.options.baseBranch ??
      await this.detectDefaultBranch(repoDir);

    // Build group branch map from completed items
    const groupBranchMap = new Map<string, string>(); // group -> branch
    for (const reportItem of report.items) {
      if (reportItem.status === "completed" && reportItem.branch) {
        const manifestItem = manifest.items.find((i) => i.id === reportItem.id);
        if (manifestItem?.group) {
          groupBranchMap.set(manifestItem.group, reportItem.branch);
        }
      }
    }

    // Determine PR specs in manifest order (deps before dependents)
    const prSpecs: Array<{
      branch: string;
      base: string;
      title: string;
      itemIds: string[];
      dependsOnItemId?: string;
      isDraft: boolean;
    }> = [];

    const processedBranches = new Set<string>();

    for (const manifestItem of manifest.items) {
      const reportItem = report.items.find((r) => r.id === manifestItem.id);
      if (!reportItem || reportItem.status !== "completed") continue;

      const branch = reportItem.branch;
      if (!branch) continue;
      if (processedBranches.has(branch)) continue;
      processedBranches.add(branch);

      // Collect all item IDs sharing this branch (grouped items)
      const itemIds = report.items
        .filter((r) => r.branch === branch && r.status === "completed")
        .map((r) => r.id);

      // Determine base branch and stacking
      let base = defaultBranch;
      let dependsOnItemId: string | undefined;
      let isDraft = this.options.draft ?? false;

      const deps = manifestItem.dependsOn;
      if (deps && deps.length > 0) {
        // Use the first dependency's branch as base for stacking
        const depId = deps[0];
        const depManifestItem = manifest.items.find((i) => i.id === depId);
        let depBranch: string | undefined;

        if (depManifestItem?.group) {
          depBranch = groupBranchMap.get(depManifestItem.group);
        } else {
          depBranch = report.items.find((r) => r.id === depId)?.branch;
        }

        if (depBranch) {
          base = depBranch;
          dependsOnItemId = depId;
          isDraft = true; // Stacked PRs are always drafts
        }
      }

      prSpecs.push({
        branch,
        base,
        title: prTitle(manifestItem.task),
        itemIds,
        dependsOnItemId,
        isDraft,
      });
    }

    // Create PRs in order so dependencies are created before dependents
    const prs: Array<{
      itemId: string;
      url: string;
      number: number;
      draft: boolean;
    }> = [];
    const branchPrInfo = new Map<string, PrCreated>();

    for (const spec of prSpecs) {
      // Resolve dep PR info for stacked PRs
      let depPrInfo: PrCreated | undefined;
      if (spec.dependsOnItemId) {
        const depReport = report.items.find((r) =>
          r.id === spec.dependsOnItemId
        );
        if (depReport?.branch) {
          depPrInfo = branchPrInfo.get(depReport.branch);
        }
        // Also check via group branch if not found
        if (!depPrInfo) {
          const depManifestItem = manifest.items.find((i) =>
            i.id === spec.dependsOnItemId
          );
          if (depManifestItem?.group) {
            const groupBranch = groupBranchMap.get(depManifestItem.group);
            if (groupBranch) {
              depPrInfo = branchPrInfo.get(groupBranch);
            }
          }
        }
      }

      const body = buildPrBody(spec.title, depPrInfo, defaultBranch);

      const result = await this.createPr({
        branch: spec.branch,
        base: spec.base,
        title: spec.title,
        body,
        draft: spec.isDraft,
      });

      if (result) {
        const created: PrCreated = {
          url: result.url,
          number: result.number,
          title: spec.title,
        };
        branchPrInfo.set(spec.branch, created);

        for (const itemId of spec.itemIds) {
          prs.push({
            itemId,
            url: result.url,
            number: result.number,
            draft: spec.isDraft,
          });
        }
      }
    }

    return { prs };
  }

  private async preflight(): Promise<void> {
    const result = await this.runner(
      ["gh", "auth", "status"],
      this.options.repoDir,
    );
    if (!result.success) {
      throw new Error(
        `gh CLI is not available or not authenticated. ` +
          `Please install gh (https://cli.github.com) and run 'gh auth login'.\n` +
          result.stderr,
      );
    }
  }

  private async detectDefaultBranch(cwd: string): Promise<string> {
    const result = await this.runner(
      ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
      cwd,
    );
    if (result.success && result.stdout) {
      const parts = result.stdout.trim().split("/");
      return parts[parts.length - 1] || "main";
    }
    return "main";
  }

  private async createPr(opts: {
    branch: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<{ url: string; number: number } | null> {
    const { repoDir } = this.options;

    const args = [
      "gh",
      "pr",
      "create",
      "--base",
      opts.base,
      "--head",
      opts.branch,
      "--title",
      opts.title,
      "--body",
      opts.body,
    ];

    if (opts.draft) {
      args.push("--draft");
    }

    for (const label of this.options.labels ?? []) {
      args.push("--label", label);
    }

    for (const reviewer of this.options.reviewers ?? []) {
      args.push("--reviewer", reviewer);
    }

    const pushResult = await this.runner(
      ["git", "push", "origin", opts.branch],
      repoDir,
    );
    if (!pushResult.success) {
      log.warn(`Failed to push branch '${opts.branch}': ${pushResult.stderr}`);
      return null;
    }

    const result = await this.runner(args, repoDir);

    if (!result.success) {
      // Handle already-existing PR gracefully
      if (
        result.stderr.includes("already exists") ||
        result.stderr.includes("already exist")
      ) {
        log.warn(
          `PR for branch '${opts.branch}' already exists, using existing PR`,
        );
        return await this.getExistingPr(opts.branch);
      }
      log.warn(
        `Failed to create PR for branch '${opts.branch}': ${result.stderr}`,
      );
      return null;
    }

    const url = result.stdout;
    const number = parsePrNumber(url);
    return { url, number };
  }

  private async getExistingPr(
    branch: string,
  ): Promise<{ url: string; number: number } | null> {
    const result = await this.runner(
      ["gh", "pr", "view", "--head", branch, "--json", "number,url"],
      this.options.repoDir,
    );
    if (!result.success) return null;
    try {
      const data = JSON.parse(result.stdout);
      return { url: data.url as string, number: data.number as number };
    } catch {
      return null;
    }
  }
}

function prTitle(task: string): string {
  const firstLine = task.split("\n")[0].trim();
  if (firstLine.length <= 72) return firstLine;
  return firstLine.slice(0, 69) + "...";
}

function buildPrBody(
  title: string,
  depPr: PrCreated | undefined,
  defaultBranch: string,
): string {
  const lines: string[] = [];
  lines.push(title);
  lines.push("");

  if (depPr) {
    lines.push("## Dependencies");
    lines.push(
      `> This PR is stacked on #${depPr.number} (${depPr.title}) and targets its branch as base.`,
    );
    lines.push(
      `> Once that PR is merged, GitHub will automatically retarget this PR to \`${defaultBranch}\`.`,
    );
    lines.push("");
  }

  lines.push("---");
  lines.push("*Created by Knox*");

  return lines.join("\n");
}

function parsePrNumber(url: string): number {
  const match = url.match(/\/pull\/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}
