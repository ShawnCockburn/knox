import type { CommandRunner } from "./output/pr_queue_output.ts";

/** A GitHub issue as returned by the gh CLI. */
export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: { login: string };
  readonly labels: Array<{ name: string }>;
  readonly pullRequest?: unknown;
}

/** Knox-managed labels applied to issues during lifecycle. */
export const KNOX_LABELS = [
  "knox/claimed",
  "knox/running",
  "knox/failed",
  "knox/blocked",
] as const;

/** The user-managed label Knox queries but never modifies. */
export const AGENT_KNOX_LABEL = "agent/knox";

/**
 * Wraps `gh` CLI interactions for GitHub Issues.
 * Accepts a `CommandRunner` for testability, matching the pattern
 * established by `PullRequestQueueOutput`.
 */
export class GitHubClient {
  private readonly runner: CommandRunner;
  private readonly cwd: string;

  constructor(cwd: string, runner: CommandRunner) {
    this.cwd = cwd;
    this.runner = runner;
  }

  /** Check that gh CLI is authenticated. Throws on failure. */
  async checkAuth(): Promise<void> {
    const result = await this.runner(["gh", "auth", "status"], this.cwd);
    if (!result.success) {
      throw new Error(
        `gh CLI is not available or not authenticated. ` +
          `Please install gh (https://cli.github.com) and run 'gh auth login'.\n` +
          result.stderr,
      );
    }
  }

  /**
   * Fetch all open issues with the `agent/knox` label.
   * Returns parsed issue objects.
   */
  async listIssues(): Promise<GitHubIssue[]> {
    const result = await this.runner(
      [
        "gh",
        "issue",
        "list",
        "--label",
        AGENT_KNOX_LABEL,
        "--state",
        "open",
        "--json",
        "number,title,body,author,labels",
        "--limit",
        "200",
      ],
      this.cwd,
    );

    if (!result.success) {
      throw new Error(`Failed to list issues: ${result.stderr}`);
    }

    const issues = JSON.parse(result.stdout) as GitHubIssue[];
    return issues;
  }

  /** Add a label to an issue. Creates the label first if it doesn't exist. */
  async addLabel(issueNumber: number, label: string): Promise<void> {
    const result = await this.runner(
      [
        "gh",
        "issue",
        "edit",
        String(issueNumber),
        "--add-label",
        label,
      ],
      this.cwd,
    );

    if (!result.success) {
      throw new Error(
        `Failed to add label '${label}' to issue #${issueNumber}: ${result.stderr}`,
      );
    }
  }

  /** Remove a label from an issue. */
  async removeLabel(issueNumber: number, label: string): Promise<void> {
    const result = await this.runner(
      [
        "gh",
        "issue",
        "edit",
        String(issueNumber),
        "--remove-label",
        label,
      ],
      this.cwd,
    );

    if (!result.success) {
      // Label might not be present — treat as non-fatal
      if (
        result.stderr.includes("not found") ||
        result.stderr.includes("does not have")
      ) {
        return;
      }
      throw new Error(
        `Failed to remove label '${label}' from issue #${issueNumber}: ${result.stderr}`,
      );
    }
  }

  /** Close an issue. */
  async closeIssue(issueNumber: number): Promise<void> {
    const result = await this.runner(
      ["gh", "issue", "close", String(issueNumber)],
      this.cwd,
    );

    if (!result.success) {
      throw new Error(
        `Failed to close issue #${issueNumber}: ${result.stderr}`,
      );
    }
  }

  /**
   * Ensure all Knox-managed labels exist in the repository.
   * Creates any missing labels silently.
   */
  async ensureLabels(): Promise<void> {
    for (const label of KNOX_LABELS) {
      const result = await this.runner(
        [
          "gh",
          "label",
          "create",
          label,
          "--force",
          "--description",
          `Managed by Knox`,
        ],
        this.cwd,
      );

      if (!result.success) {
        // Non-fatal — label may already exist or permissions may be limited
        // The --force flag should handle "already exists", but just in case
      }
    }
  }
}
