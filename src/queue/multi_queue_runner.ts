import { basename } from "@std/path";
import type { ContainerRuntime } from "../shared/runtime/container_runtime.ts";
import { log } from "../shared/log.ts";
import { DirectoryQueueSource } from "./directory_queue_source.ts";
import { Orchestrator } from "./orchestrator.ts";
import type { QueueReport } from "./orchestrator.ts";
import { BranchQueueOutput } from "./output.ts";
import type { QueueOutput } from "./output.ts";
import { StaticRenderer } from "./tui/static_renderer.ts";
import { QueueTUI } from "./tui/queue_tui.ts";

/** Options for running multiple queues sequentially. */
export interface MultiQueueRunnerOptions {
  /** Absolute paths to queue directories (each must contain queue.yaml). */
  queueDirs: string[];
  /** Pre-resolved container image. */
  image: string;
  /** Resolved environment variables (auth + user-supplied). */
  envVars: string[];
  /** Allowed outbound IPs for containers. */
  allowedIPs: string[];
  /** Project source directory. */
  dir: string;
  signal?: AbortSignal;
  verbose?: boolean;
  resume?: boolean;
  /** Whether to use the live TUI (requires TTY). */
  useTUI?: boolean;
  /** Container runtime override (for testing). */
  runtime?: ContainerRuntime;
  /** Post-queue output handler. */
  output?: QueueOutput;
}

/** Aggregated result across all queues. */
export interface MultiQueueReport {
  queues: Array<{ name: string; report: QueueReport }>;
}

/**
 * Runs multiple queues sequentially, printing a separator between each.
 */
export class MultiQueueRunner {
  constructor(private readonly options: MultiQueueRunnerOptions) {}

  async run(): Promise<MultiQueueReport> {
    const { queueDirs, signal } = this.options;
    const output = this.options.output ?? new BranchQueueOutput();
    const results: Array<{ name: string; report: QueueReport }> = [];

    for (let i = 0; i < queueDirs.length; i++) {
      if (signal?.aborted) break;

      const queueDir = queueDirs[i];
      const queueName = basename(queueDir);

      // Separator between queues
      if (i > 0) {
        console.error(`\n${"─".repeat(40)}`);
      }
      console.error(`\nQueue: ${queueName}`);

      const source = new DirectoryQueueSource(queueDir);

      // Load manifest to get item IDs for TUI/renderer
      const loadResult = await source.load();
      if (!loadResult.ok) {
        log.error(`Failed to load queue "${queueName}":`);
        for (const err of loadResult.errors) {
          log.error(`  ${err.message}`);
        }
        continue;
      }

      const manifest = loadResult.manifest;
      const itemIds = manifest.items.map((item) => item.id);
      const isVerbose = this.options.verbose ?? false;
      const useTUI = this.options.useTUI ?? false;

      let renderer: StaticRenderer | QueueTUI;
      if (useTUI) {
        renderer = new QueueTUI(itemIds, { verbose: isVerbose, queueName });
      } else {
        renderer = new StaticRenderer({ verbose: isVerbose });
      }

      if (useTUI) log.mute();
      renderer.start();

      const logDir = `${queueDir}.logs`;

      const orchestrator = new Orchestrator({
        source,
        image: this.options.image,
        envVars: this.options.envVars,
        allowedIPs: this.options.allowedIPs,
        dir: this.options.dir,
        logDir,
        signal,
        resume: this.options.resume,
        verbose: isVerbose,
        suppressSummary: true,
        runtime: this.options.runtime,
        onLine: (itemId, line) => renderer.appendLine(itemId, line),
        onEvent: (itemId, event) => renderer.update(itemId, event),
        onItemRunning: (itemId) => renderer.markItemRunning(itemId),
        onItemCompleted: (itemId, branch) =>
          renderer.markItemCompleted(itemId, branch),
        onItemFailed: (itemId, error) => renderer.markItemFailed(itemId, error),
        onItemBlocked: (itemId, blockedBy) =>
          renderer.markItemBlocked(itemId, blockedBy),
      });

      const report = await orchestrator.run();
      renderer.stop();
      if (useTUI) log.unmute();

      console.error(renderer.formatSummary());

      // Run post-queue output handler (e.g., create PRs)
      await output.onQueueComplete(report);

      results.push({ name: queueName, report });
    }

    return { queues: results };
  }

  /** Print a combined summary table grouped by queue name. */
  static printCombinedSummary(multiReport: MultiQueueReport): void {
    if (multiReport.queues.length === 0) return;
    console.error(`\n${"═".repeat(40)}`);
    console.error("Combined Summary");
    for (const { name, report } of multiReport.queues) {
      const total = report.items.length;
      const completed = report.items.filter((i) => i.status === "completed")
        .length;
      const failed = report.items.filter((i) => i.status === "failed").length;
      const blocked = report.items.filter((i) => i.status === "blocked").length;
      const parts: string[] = [];
      if (completed > 0) parts.push(`${completed} completed`);
      if (failed > 0) parts.push(`${failed} failed`);
      if (blocked > 0) parts.push(`${blocked} blocked`);
      console.error(
        `  ${name}  ${total} item${total !== 1 ? "s" : ""}  ${
          parts.join(", ") || "no items ran"
        }`,
      );
    }
  }
}
