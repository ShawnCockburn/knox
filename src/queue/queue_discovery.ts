import { join } from "@std/path";
import type { ResolveDifficulty } from "../difficulty/mod.ts";
import { DirectoryQueueSource } from "./directory_queue_source.ts";
import { Orchestrator } from "./orchestrator.ts";
import type { OrchestratorOptions, QueueReport } from "./orchestrator.ts";

/** A queue directory discovered under <projectDir>/.knox/queues/. */
export interface DiscoveredQueue {
  name: string; // directory name (e.g., "auth-refactor")
  path: string; // absolute path to queue directory
}

/**
 * Scans <projectDir>/.knox/queues/ for subdirectories.
 * A subdirectory qualifies as a queue if it contains at least one .md file
 * (excluding _-prefixed files). Returns sorted alphabetically by name.
 */
export async function discoverQueues(
  projectDir: string,
): Promise<DiscoveredQueue[]> {
  const queuesDir = join(projectDir, ".knox", "queues");

  try {
    await Deno.stat(queuesDir);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return [];
    }
    throw e;
  }

  const discovered: DiscoveredQueue[] = [];

  for await (const entry of Deno.readDir(queuesDir)) {
    if (!entry.isDirectory) continue;

    const queuePath = join(queuesDir, entry.name);

    // Check for at least one qualifying .md file
    let hasMd = false;
    for await (const file of Deno.readDir(queuePath)) {
      if (
        file.isFile &&
        file.name.endsWith(".md") &&
        !file.name.startsWith("_")
      ) {
        hasMd = true;
        break;
      }
    }

    if (hasMd) {
      discovered.push({ name: entry.name, path: queuePath });
    }
  }

  return discovered.sort((a, b) => a.name.localeCompare(b.name));
}

/** Combined report from running multiple queues. */
export interface MultiQueueReport {
  queues: Array<{ name: string; report: QueueReport }>;
  durationMs: number;
}

/** Options for the multi-queue runner. */
export interface MultiQueueRunnerOptions {
  queues: DiscoveredQueue[];
  image: string;
  envVars: string[];
  allowedIPs: string[];
  resolveDifficulty: ResolveDifficulty;
  dir: string;
  signal?: AbortSignal;
  verbose?: boolean;
  resume?: boolean;
  queueOutput?: {
    deliver(name: string, report: QueueReport): Promise<void> | void;
  };
  onQueueStart?: (name: string) => void;
  onQueueComplete?: (name: string, report: QueueReport) => void;
  /** Internal: override orchestrator construction for testing. */
  _orchestratorFactory?: (
    opts: OrchestratorOptions,
  ) => { run(): Promise<QueueReport> };
}

/**
 * Runs each discovered queue sequentially.
 * If the abort signal fires mid-queue, remaining queues are skipped.
 */
export async function runMultiQueue(
  options: MultiQueueRunnerOptions,
): Promise<MultiQueueReport> {
  const startTime = Date.now();
  const results: Array<{ name: string; report: QueueReport }> = [];

  for (const queue of options.queues) {
    if (options.signal?.aborted) break;

    options.onQueueStart?.(queue.name);

    const source = new DirectoryQueueSource(queue.path);
    const logDir = join(queue.path, ".logs");

    const orchOpts: OrchestratorOptions = {
      source,
      image: options.image,
      envVars: options.envVars,
      allowedIPs: options.allowedIPs,
      resolveDifficulty: options.resolveDifficulty,
      dir: options.dir,
      logDir,
      signal: options.signal,
      verbose: options.verbose,
      resume: options.resume,
      suppressSummary: true,
    };

    const orchestrator = options._orchestratorFactory
      ? options._orchestratorFactory(orchOpts)
      : new Orchestrator(orchOpts);

    const report = await orchestrator.run();
    results.push({ name: queue.name, report });

    if (options.queueOutput) {
      await options.queueOutput.deliver(queue.name, report);
    }

    options.onQueueComplete?.(queue.name, report);
  }

  return {
    queues: results,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Returns 0 if every item in every queue completed, 1 otherwise.
 */
export function multiQueueExitCode(report: MultiQueueReport): number {
  for (const { report: queueReport } of report.queues) {
    for (const item of queueReport.items) {
      if (item.status !== "completed") return 1;
    }
  }
  return 0;
}
