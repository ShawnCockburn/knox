import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { Orchestrator } from "./orchestrator.ts";
import type { OrchestratorOptions, QueueReport } from "./orchestrator.ts";
import type { ItemState, LoadResult, QueueSource, QueueState } from "./types.ts";
import { validateManifest } from "./validation.ts";

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

/** Receives the final report for a queue after it completes. */
export interface QueueOutput {
  deliver(name: string, report: QueueReport): Promise<void> | void;
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
  dir: string;
  signal?: AbortSignal;
  verbose?: boolean;
  resume?: boolean;
  queueOutput?: QueueOutput;
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

/**
 * Queue source backed by a directory of markdown task files.
 * Each .md file (excluding _-prefixed) in the directory is a queue item.
 * The filename without extension becomes the item ID; the file content is the task.
 */
export class DirectoryQueueSource implements QueueSource {
  private readonly statePath: string;

  constructor(private readonly dirPath: string) {
    this.statePath = join(dirPath, ".state.yaml");
  }

  async load(): Promise<LoadResult> {
    const items: Array<{ id: string; task: string }> = [];

    for await (const entry of Deno.readDir(this.dirPath)) {
      if (!entry.isFile) continue;
      if (!entry.name.endsWith(".md")) continue;
      if (entry.name.startsWith("_")) continue;

      const id = entry.name.replace(/\.md$/, "");
      const task = await Deno.readTextFile(join(this.dirPath, entry.name));
      items.push({ id, task: task.trim() });
    }

    items.sort((a, b) => a.id.localeCompare(b.id));

    const result = validateManifest({ items });

    if (result.errors.length > 0) {
      return { ok: false, errors: result.errors };
    }

    return { ok: true, manifest: result.manifest! };
  }

  async update(itemId: string, state: Partial<ItemState>): Promise<void> {
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
}
