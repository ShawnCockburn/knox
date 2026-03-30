import type { KnoxEngineOptions, KnoxOutcome } from "../engine/knox.ts";
import { Knox } from "../engine/knox.ts";
import { generateRunId } from "../shared/types.ts";
import type { KnoxEvent, RunId } from "../shared/types.ts";
import { log } from "../shared/log.ts";
import type {
  EnvironmentConfig,
  QueueItem,
  QueueManifest,
  QueueSource,
  QueueState,
} from "./types.ts";
import { formatDuration } from "../cli/format.ts";
import type { QueueOutput, QueueOutputResult } from "./output/queue_output.ts";

/**
 * Resolves environment config to a Docker image ID.
 * Used by the orchestrator for per-item image resolution.
 */
export type ImageResolver = (env: EnvironmentConfig) => Promise<string>;

/** Options for running the queue orchestrator. */
export interface OrchestratorOptions {
  source: QueueSource;
  /** Pre-resolved default image (used when item has no environment config). */
  image: string;
  /** Resolves per-item environment config to a Docker image. */
  imageResolver?: ImageResolver;
  envVars: string[];
  allowedIPs: string[];
  dir: string;
  /** Per-item log directory. */
  logDir: string;
  signal?: AbortSignal;
  verbose?: boolean;
  /** Callback for agent output lines. */
  onLine?: (itemId: string, line: string) => void;
  /** Callback for structured lifecycle events. */
  onEvent?: (itemId: string, event: KnoxEvent) => void;
  /** Callbacks for orchestrator-level item state changes. */
  onItemRunning?: (itemId: string) => void;
  onItemCompleted?: (itemId: string, branch?: string) => void;
  onItemFailed?: (itemId: string, error: string) => void;
  onItemBlocked?: (itemId: string, blockedBy: string) => void;
  /** Suppress the text summary (when TUI handles display). */
  suppressSummary?: boolean;
  /** Container runtime override (for testing). */
  runtime?: import("../shared/runtime/container_runtime.ts").ContainerRuntime;
  /** Engine factory override (for testing). */
  engineFactory?: (opts: KnoxEngineOptions) => { run(): Promise<KnoxOutcome> };
  /** Resume from existing state file. */
  resume?: boolean;
  /** Optional output stage called after all items complete. */
  queueOutput?: QueueOutput;
}

/** Final report for the queue run. */
export interface QueueReport {
  queueRunId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  items: QueueReportItem[];
  manifest: QueueManifest;
  outputResult?: QueueOutputResult;
}

export interface QueueReportItem {
  id: string;
  status: string;
  branch?: string;
  durationMs?: number;
  outcome?: KnoxOutcome;
  blockedBy?: string;
}

export class Orchestrator {
  private readonly options: OrchestratorOptions;

  constructor(options: OrchestratorOptions) {
    this.options = options;
  }

  async run(): Promise<QueueReport> {
    const { source } = this.options;

    // 1. Load and validate manifest
    const loadResult = await source.load();
    if (!loadResult.ok) {
      throw new OrchestratorValidationError(loadResult.errors);
    }
    const manifest = loadResult.manifest;

    // 2. Initialize or resume state
    let queueRunId: string;
    let startedAt: string;
    let state: QueueState;

    const existingState = "readState" in source &&
        typeof source.readState === "function"
      ? await (source as { readState(): Promise<QueueState | null> })
        .readState()
      : null;

    if (this.options.resume && existingState) {
      // Resume: preserve run ID, reset failed→pending, re-evaluate blocked
      queueRunId = existingState.queueRunId;
      startedAt = existingState.startedAt;
      state = existingState;

      for (const item of manifest.items) {
        const s = state.items[item.id];
        if (!s) {
          state.items[item.id] = { status: "pending" };
        } else if (s.status === "failed" || s.status === "blocked") {
          // Reset failed and blocked items to pending — the scheduler
          // will re-evaluate deps and only run items whose deps are met
          state.items[item.id] = { status: "pending" };
        } else if (s.status === "in_progress") {
          // in_progress from a crashed previous run — retry
          state.items[item.id] = { status: "pending" };
        }
        // completed items left as-is
      }

      log.info(`Resuming queue run ${queueRunId}`);
    } else {
      // Fresh run
      if (existingState && !this.options.resume) {
        log.warn(
          "State file exists from a previous run. Use --resume to continue, or it will be overwritten.",
        );
      }

      queueRunId = generateRunId();
      startedAt = new Date().toISOString();
      state = {
        queueRunId,
        startedAt,
        items: {},
      };

      for (const item of manifest.items) {
        state.items[item.id] = { status: "pending" };
      }
    }

    // 3. Create log directory (must happen before state write, since
    //    the state file may live under the same parent .knox/ directory)
    await Deno.mkdir(this.options.logDir, { recursive: true });

    await this.writeState(source, state);

    // 4. Schedule and run items
    await this.runScheduler(manifest, state, queueRunId);

    // 5. Finalize
    const finishedAt = new Date().toISOString();
    state.finishedAt = finishedAt;
    await this.writeState(source, state);

    const durationMs = new Date(finishedAt).getTime() -
      new Date(startedAt).getTime();

    // 6. Print summary to stderr (unless TUI handles display)
    if (!this.options.suppressSummary) {
      this.printSummary(manifest, state, durationMs);
    }

    // 7. Build report
    const report = this.buildReport(
      manifest,
      state,
      queueRunId,
      startedAt,
      finishedAt,
      durationMs,
    );

    // 8. Deliver output (if configured)
    if (this.options.queueOutput) {
      report.outputResult = await this.options.queueOutput.deliver(
        report,
        manifest,
      );
    }

    return report;
  }

  private async runScheduler(
    manifest: QueueManifest,
    state: QueueState,
    queueRunId: string,
  ): Promise<void> {
    const { source, signal } = this.options;
    const concurrency = manifest.concurrency ?? 1;

    // Track group branches for chained execution
    // Pre-populate from completed items in state (for resume)
    const groupBranches = new Map<string, string>();
    for (const item of manifest.items) {
      if (item.group && state.items[item.id]?.status === "completed") {
        const branch = state.items[item.id].branch;
        if (branch) {
          groupBranches.set(item.group, branch);
        }
      }
    }

    while (true) {
      if (signal?.aborted) {
        // Mark remaining pending items as blocked
        for (const item of manifest.items) {
          if (state.items[item.id].status === "pending") {
            state.items[item.id].status = "blocked";
            state.items[item.id].blockedBy = "aborted";
            this.options.onItemBlocked?.(item.id, "aborted");
            await source.update(item.id, state.items[item.id]);
          }
        }
        break;
      }

      const ready = this.findReadyItems(manifest, state);
      if (ready.length === 0) break;

      // Take up to concurrency items
      const batch = ready.slice(0, concurrency);
      const running = batch.map((item) =>
        this.runItem(item, manifest, state, queueRunId, groupBranches)
      );

      // For concurrency > 1, we run items in parallel
      // Sink collection is serialized inside runItem via the mutex
      await Promise.all(running);
    }
  }

  private findReadyItems(
    manifest: QueueManifest,
    state: QueueState,
  ): QueueItem[] {
    const ready: QueueItem[] = [];

    for (const item of manifest.items) {
      const itemState = state.items[item.id];
      if (itemState.status !== "pending") continue;

      const deps = item.dependsOn ?? [];
      const allDepsCompleted = deps.every(
        (dep) => state.items[dep].status === "completed",
      );

      if (allDepsCompleted) {
        ready.push(item);
      }
    }

    return ready;
  }

  private async runItem(
    item: QueueItem,
    manifest: QueueManifest,
    state: QueueState,
    queueRunId: string,
    groupBranches: Map<string, string>,
  ): Promise<void> {
    const { source, signal } = this.options;
    const defaults = manifest.defaults ?? {};

    // Mark in_progress
    const itemStartedAt = new Date().toISOString();
    state.items[item.id] = {
      status: "in_progress",
      startedAt: itemStartedAt,
    };
    await source.update(item.id, state.items[item.id]);
    this.options.onItemRunning?.(item.id);
    log.info(`[${item.id}] Starting...`);

    // Merge defaults + item overrides
    const model = item.model ?? defaults.model ?? "sonnet";
    const maxLoops = item.maxLoops ?? defaults.maxLoops ?? 10;
    const check = item.check ?? defaults.check;
    const cpu = item.cpu ?? defaults.cpu;
    const memory = item.memory ?? defaults.memory;
    const env = [...(defaults.env ?? []), ...(item.env ?? [])];

    // Resolve prompt
    let customPrompt: string | undefined;
    const promptPath = item.prompt ?? defaults.prompt;
    if (promptPath) {
      customPrompt = await Deno.readTextFile(promptPath);
    }

    // Resolve per-item environment → image
    // If item declares features/prepare/image, it replaces defaults entirely (no merge)
    const itemHasEnv = item.features !== undefined ||
      item.prepare !== undefined ||
      item.image !== undefined;
    let itemImage = this.options.image; // default
    if (itemHasEnv && this.options.imageResolver) {
      itemImage = await this.options.imageResolver({
        features: item.features,
        prepare: item.prepare,
        image: item.image,
      });
    }

    // Determine run ID
    const runId: RunId = generateRunId();

    // Build source provider options for groups
    const sourceRef = item.group ? groupBranches.get(item.group) : undefined;
    // Group branch naming: knox/<group>-<queueRunId>
    const groupBranchName = item.group
      ? `knox/${item.group}-${queueRunId}`
      : undefined;

    // Set up per-item log file
    const logPath = `${this.options.logDir}/${item.id}.log`;
    const logFile = await Deno.open(logPath, {
      write: true,
      create: true,
      truncate: true,
    });

    const onLine = (line: string) => {
      // Write to log file
      const encoder = new TextEncoder();
      logFile.writeSync(encoder.encode(line + "\n"));
      // Forward to caller if verbose
      this.options.onLine?.(item.id, line);
    };

    const onEvent = (event: KnoxEvent) => {
      this.options.onEvent?.(item.id, event);
    };

    // Build engine options
    const engineOpts: KnoxEngineOptions = {
      task: item.task,
      dir: this.options.dir,
      image: itemImage,
      envVars: [...this.options.envVars, ...env],
      allowedIPs: this.options.allowedIPs,
      runId,
      model,
      maxLoops,
      customPrompt,
      check,
      cpuLimit: cpu,
      memoryLimit: memory,
      onLine,
      onEvent,
      signal,
      runtime: this.options.runtime,
      branchName: groupBranchName,
    };

    // Add source provider with ref for group chains
    if (sourceRef) {
      const { GitSourceProvider } = await import(
        "../engine/source/git_source_provider.ts"
      );
      engineOpts.sourceProvider = new GitSourceProvider(
        this.options.dir,
        sourceRef,
      );
    }

    try {
      // Run engine
      const engine = this.options.engineFactory
        ? this.options.engineFactory(engineOpts)
        : new Knox(engineOpts);
      const outcome = await engine.run();

      logFile.close();

      const itemFinishedAt = new Date().toISOString();
      const itemDurationMs = new Date(itemFinishedAt).getTime() -
        new Date(itemStartedAt).getTime();

      if (outcome.ok && outcome.result.aborted) {
        // Aborted: container was killed mid-execution
        state.items[item.id] = {
          status: "blocked",
          startedAt: itemStartedAt,
          finishedAt: itemFinishedAt,
          durationMs: itemDurationMs,
          blockedBy: "aborted",
          outcome,
        };
        log.info(`[${item.id}] Aborted`);
      } else if (outcome.ok && outcome.result.completed) {
        const branch = outcome.result.sink.strategy === "host-git"
          ? outcome.result.sink.branchName
          : undefined;

        state.items[item.id] = {
          status: "completed",
          startedAt: itemStartedAt,
          finishedAt: itemFinishedAt,
          durationMs: itemDurationMs,
          branch,
          outcome,
        };

        // Track group branch for chaining
        if (item.group && branch) {
          groupBranches.set(item.group, branch);
        }

        this.options.onItemCompleted?.(item.id, branch);
        log.info(
          `[${item.id}] Completed in ${formatDuration(itemDurationMs)}${
            branch ? ` → ${branch}` : ""
          }`,
        );
      } else if (outcome.ok && !outcome.result.completed) {
        // Agent ran successfully but never signaled KNOX_COMPLETE
        state.items[item.id] = {
          status: "failed",
          startedAt: itemStartedAt,
          finishedAt: itemFinishedAt,
          durationMs: itemDurationMs,
          outcome,
        };

        this.options.onItemFailed?.(item.id, "Agent did not signal completion");
        log.info(
          `[${item.id}] Failed: agent ran ${outcome.result.loopsRun} loop(s) without signaling completion`,
        );
        this.blockDependents(item.id, manifest, state);
      } else if (!outcome.ok) {
        state.items[item.id] = {
          status: "failed",
          startedAt: itemStartedAt,
          finishedAt: itemFinishedAt,
          durationMs: itemDurationMs,
          outcome,
        };

        this.options.onItemFailed?.(item.id, outcome.error);
        log.info(`[${item.id}] Failed (phase: ${outcome.phase}): ${outcome.error}`);

        // Block dependents transitively
        this.blockDependents(item.id, manifest, state);
      }
    } catch (e) {
      logFile.close();

      const itemFinishedAt = new Date().toISOString();
      const itemDurationMs = new Date(itemFinishedAt).getTime() -
        new Date(itemStartedAt).getTime();

      state.items[item.id] = {
        status: "failed",
        startedAt: itemStartedAt,
        finishedAt: itemFinishedAt,
        durationMs: itemDurationMs,
      };

      const errMsg = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error ? e.stack : undefined;
      log.error(`[${item.id}] Crashed: ${errMsg}`);
      if (stack) log.debug(`[${item.id}] Stack: ${stack}`);
      this.blockDependents(item.id, manifest, state);
    }

    await source.update(item.id, state.items[item.id]);
  }

  private blockDependents(
    failedId: string,
    manifest: QueueManifest,
    state: QueueState,
  ): void {
    // Find direct dependents
    for (const item of manifest.items) {
      if (
        state.items[item.id].status === "pending" &&
        (item.dependsOn ?? []).includes(failedId)
      ) {
        state.items[item.id] = {
          ...state.items[item.id],
          status: "blocked",
          blockedBy: failedId,
        };
        this.options.onItemBlocked?.(item.id, failedId);
        // Recursively block their dependents
        this.blockDependents(item.id, manifest, state);
      }
    }
  }

  private async writeState(
    source: QueueSource,
    state: QueueState,
  ): Promise<void> {
    // Use FileQueueSource.writeState if available, otherwise update each item
    if ("writeState" in source && typeof source.writeState === "function") {
      await (source as { writeState(s: QueueState): Promise<void> }).writeState(
        state,
      );
    }
  }

  private printSummary(
    manifest: QueueManifest,
    state: QueueState,
    durationMs: number,
  ): void {
    log.always(`\nQueue Summary (${formatDuration(durationMs)})`);

    for (const item of manifest.items) {
      const s = state.items[item.id];
      const duration = s.durationMs ? ` (${formatDuration(s.durationMs)})` : "";
      const branch = s.branch ? ` → ${s.branch}` : "";
      const blocked = s.blockedBy ? ` [blocked by: ${s.blockedBy}]` : "";
      log.always(`  ${item.id}: ${s.status}${duration}${branch}${blocked}`);
    }
  }

  private buildReport(
    manifest: QueueManifest,
    state: QueueState,
    queueRunId: string,
    startedAt: string,
    finishedAt: string,
    durationMs: number,
  ): QueueReport {
    return {
      queueRunId,
      startedAt,
      finishedAt,
      durationMs,
      manifest,
      items: manifest.items.map((item) => {
        const s = state.items[item.id];
        return {
          id: item.id,
          status: s.status,
          branch: s.branch,
          durationMs: s.durationMs,
          outcome: s.outcome,
          blockedBy: s.blockedBy,
        };
      }),
    };
  }
}

/** Error thrown when manifest validation fails. */
export class OrchestratorValidationError extends Error {
  constructor(
    public readonly errors: Array<{
      itemId?: string;
      field?: string;
      message: string;
    }>,
  ) {
    const messages = errors.map((e) => e.message).join("\n  ");
    super(`Queue validation failed:\n  ${messages}`);
    this.name = "OrchestratorValidationError";
  }
}
