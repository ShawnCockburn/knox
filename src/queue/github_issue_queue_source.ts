import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import type { CommandRunner } from "./output/pr_queue_output.ts";
import { GitHubClient } from "./github_client.ts";
import { mapIssueToQueueItem } from "./issue_mapper.ts";
import { validateManifest } from "./validation.ts";
import { log } from "../shared/log.ts";
import type {
  ItemState,
  LoadResult,
  QueueDefaults,
  QueueSource,
  QueueState,
} from "./types.ts";

export interface GitHubIssueQueueSourceOptions {
  /** Working directory (repo root). */
  cwd: string;
  /** Path to the state file. */
  statePath: string;
  /** Queue-level defaults from .knox/config.yaml github.defaults. */
  defaults?: QueueDefaults;
  /** CommandRunner for testability. */
  runner: CommandRunner;
}

/**
 * Queue source backed by GitHub Issues labeled `agent/knox`.
 *
 * Fetches open issues from the current repository, parses their bodies
 * using the existing Markdown task parser, and builds a QueueManifest.
 * State is persisted to a local `.state.yaml` file.
 *
 * On completion, issues are closed and the `knox/claimed` label is removed.
 */
export class GitHubIssueQueueSource implements QueueSource {
  private readonly client: GitHubClient;
  private readonly statePath: string;
  private readonly defaults?: QueueDefaults;

  /** Map from item ID → issue number, populated during load(). */
  private issueNumbers = new Map<string, number>();

  constructor(options: GitHubIssueQueueSourceOptions) {
    this.client = new GitHubClient(options.cwd, options.runner);
    this.statePath = options.statePath;
    this.defaults = options.defaults;
  }

  async load(): Promise<LoadResult> {
    // Auto-create knox/* labels if missing
    await this.client.ensureLabels();

    // Fetch open issues with agent/knox label
    const issues = await this.client.listIssues();

    if (issues.length === 0) {
      return {
        ok: false,
        errors: [{
          message:
            "No open issues found with the 'agent/knox' label in this repository.",
        }],
      };
    }

    // Filter out pull requests (GitHub issue API includes PRs)
    const filteredIssues = issues.filter((issue) => !issue.pullRequest);

    if (filteredIssues.length === 0) {
      return {
        ok: false,
        errors: [{
          message:
            "All issues with 'agent/knox' label are pull requests. No tasks to process.",
        }],
      };
    }

    // Map issues to QueueItems
    const items = [];
    const errors = [];

    for (const issue of filteredIssues) {
      const result = mapIssueToQueueItem(issue);

      if (!result.ok) {
        errors.push(...result.errors);
        continue;
      }

      if (result.warnings) {
        for (const w of result.warnings) {
          log.warn(w.message);
        }
      }

      items.push(result.item);
      this.issueNumbers.set(result.item.id, issue.number);
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    // Resolve #N shorthand in dependsOn to full item IDs.
    // Build a reverse map: issue number → item ID
    const numberToItemId = new Map<number, string>();
    for (const [itemId, issueNum] of this.issueNumbers) {
      numberToItemId.set(issueNum, itemId);
    }

    const resolvedItems: typeof items = items.map((item) => {
      if (!item.dependsOn) return item;
      const deps = item.dependsOn.map((dep) => {
        const match = dep.match(/^#(\d+)$/);
        if (!match) return dep;
        const num = parseInt(match[1], 10);
        return numberToItemId.get(num) ?? dep; // leave as-is; validation will catch it
      });
      return { ...item, dependsOn: deps };
    });
    items.length = 0;
    items.push(...resolvedItems);

    // Assemble raw manifest and validate
    const rawManifest = {
      items,
      ...(this.defaults !== undefined && { defaults: this.defaults }),
    };

    const validationResult = validateManifest(rawManifest);

    if (validationResult.errors.length > 0) {
      return { ok: false, errors: validationResult.errors };
    }

    return { ok: true, manifest: validationResult.manifest! };
  }

  async update(itemId: string, state: Partial<ItemState>): Promise<void> {
    // Write to local state file
    let queueState: QueueState;

    try {
      const text = await Deno.readTextFile(this.statePath);
      queueState = parseYaml(text) as QueueState;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        queueState = {
          queueRunId: "",
          startedAt: new Date().toISOString(),
          items: {},
        };
      } else {
        throw e;
      }
    }

    queueState.items[itemId] = {
      ...queueState.items[itemId],
      ...state,
    };

    await Deno.writeTextFile(
      this.statePath,
      stringifyYaml(queueState as unknown as Record<string, unknown>),
    );

    // On completion: close issue, remove knox/claimed label
    if (state.status === "completed") {
      const issueNumber = this.issueNumbers.get(itemId);
      if (issueNumber) {
        try {
          await this.client.closeIssue(issueNumber);
        } catch (e) {
          log.warn(
            `Failed to close issue #${issueNumber}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
        try {
          await this.client.removeLabel(issueNumber, "knox/claimed");
        } catch {
          // Cosmetic — don't fail the item
        }
      }
    }
  }

  /** Read the existing state file. Returns null if it doesn't exist. */
  async readState(): Promise<QueueState | null> {
    try {
      const text = await Deno.readTextFile(this.statePath);
      return parseYaml(text) as QueueState;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
  }

  /** Write the full state file (used for initialization and resume). */
  async writeState(state: QueueState): Promise<void> {
    await Deno.writeTextFile(
      this.statePath,
      stringifyYaml(state as unknown as Record<string, unknown>),
    );
  }

  /** Get the state file path. */
  getStatePath(): string {
    return this.statePath;
  }

  /** Get the issue number for a given item ID. */
  getIssueNumber(itemId: string): number | undefined {
    return this.issueNumbers.get(itemId);
  }
}
