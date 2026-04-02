import type { ContainerRuntime } from "../shared/runtime/container_runtime.ts";
import { DockerRuntime } from "../shared/runtime/docker_runtime.ts";
import { AgentRunner } from "./agent/agent_runner.ts";
import { ClaudeCodeAgentProvider } from "./agent/claude_code_agent_provider.ts";
import { ContainerSession } from "./session/container_session.ts";
import { generateRunId, taskSlug } from "../shared/types.ts";
import type {
  FailurePhase,
  ImageId,
  KnoxEvent,
  RunId,
} from "../shared/types.ts";
import type { SourceProvider } from "./source/source_provider.ts";
import { GitSourceProvider } from "./source/git_source_provider.ts";
import type { ResultSink, SinkResult } from "./sink/result_sink.ts";
import { SinkStrategy } from "./sink/result_sink.ts";
import { GitBranchSink } from "./sink/git_branch_sink.ts";
import { log } from "../shared/log.ts";
import type { Difficulty } from "../difficulty/mod.ts";

export interface KnoxEngineOptions {
  task: string;
  dir: string;
  image: ImageId;
  envVars: string[];
  allowedIPs: string[];
  runId?: RunId;
  maxLoops?: number;
  difficulty?: Difficulty;
  model?: string;
  customPrompt?: string;
  check?: string;
  cpuLimit?: string;
  memoryLimit?: string;
  projectSetup?: string;
  onLine?: (line: string) => void;
  onEvent?: (event: KnoxEvent) => void;
  signal?: AbortSignal;
  runtime?: ContainerRuntime;
  sourceProvider?: SourceProvider;
  resultSink?: ResultSink;
  /** Override branch name in sink (used by queue orchestrator for groups). */
  branchName?: string;
}

export interface KnoxResult {
  runId: RunId;
  completed: boolean;
  aborted: boolean;
  loopsRun: number;
  maxLoops: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  difficulty: Difficulty;
  model: string;
  task: string;
  autoCommitted: boolean;
  checkPassed: boolean | null;
  sink: SinkResult;
}

export type KnoxOutcome =
  | { ok: true; result: KnoxResult }
  | {
    ok: false;
    error: string;
    phase: FailurePhase;
    partial?: Partial<KnoxResult>;
  };

export class Knox {
  private options: KnoxEngineOptions;
  private runtime: ContainerRuntime;

  constructor(options: KnoxEngineOptions) {
    this.options = options;
    this.runtime = options.runtime ?? new DockerRuntime();
  }

  async run(): Promise<KnoxOutcome> {
    const startedAt = new Date().toISOString();
    const runId = this.options.runId ?? generateRunId();
    const runDir = `/tmp/knox-${runId}`;

    const {
      task,
      dir,
      image,
      envVars,
      allowedIPs,
      maxLoops = 10,
      model = "sonnet",
      difficulty = "balanced",
      customPrompt,
      check,
      cpuLimit,
      memoryLimit,
      projectSetup,
      onLine,
      onEvent,
      signal,
    } = this.options;

    const emit = (event: KnoxEvent) => onEvent?.(event);

    log.debug(
      `[knox] Starting run ${runId}: image=${image} model=${model} maxLoops=${maxLoops}`,
    );
    log.debug(`[knox] dir=${dir} runDir=${runDir}`);
    log.debug(
      `[knox] envVars: ${envVars.map((e) => e.split("=")[0]).join(", ")}`,
    );
    log.debug(`[knox] allowedIPs: ${allowedIPs.join(", ")}`);
    log.debug(`[knox] task: ${task.slice(0, 200)}`);

    // Create run temp directory
    await Deno.mkdir(runDir, { recursive: true });

    const sourceProvider = this.options.sourceProvider ??
      new GitSourceProvider(dir);
    const resultSink = this.options.resultSink ?? new GitBranchSink(dir);
    log.debug(`[knox] Source provider: ${sourceProvider.constructor.name}`);
    log.debug(`[knox] Result sink: ${resultSink.constructor.name}`);

    let session: ContainerSession | undefined;
    let onAbort: (() => void) | undefined;

    const partial: Partial<KnoxResult> = {
      runId,
      task,
      difficulty,
      model,
      maxLoops,
      startedAt,
      aborted: false,
    };

    const makeAbortResult = (): KnoxOutcome => {
      emit({ type: "aborted" });
      const finishedAt = new Date().toISOString();
      const durationMs = new Date(finishedAt).getTime() -
        new Date(startedAt).getTime();
      return {
        ok: true,
        result: {
          runId,
          completed: false,
          aborted: true,
          loopsRun: partial.loopsRun ?? 0,
          maxLoops,
          startedAt,
          finishedAt,
          durationMs,
          difficulty,
          model,
          task,
          autoCommitted: partial.autoCommitted ?? false,
          checkPassed: null,
          sink: partial.sink ??
            {
              strategy: SinkStrategy.HostGit,
              branchName: "",
              commitCount: 0,
              autoCommitted: false,
            },
        },
      };
    };

    try {
      // Check abort before container creation
      if (signal?.aborted) return makeAbortResult();

      // Create sandboxed container session
      log.debug(`[knox] Creating container session...`);
      try {
        session = await ContainerSession.create({
          runtime: this.runtime,
          runId,
          runDir,
          image,
          envVars,
          allowedIPs,
          sourceProvider,
          cpuLimit,
          memoryLimit,
          projectSetup,
        });
        log.debug(`[knox] Container session created: ${session.containerId}`);
        emit({ type: "container:created", containerId: session.containerId });

        // Register abort listener to kill container immediately
        onAbort = () => {
          session!.dispose();
        };
        signal?.addEventListener("abort", onAbort);
      } catch (e) {
        log.debug(
          `[knox] Container creation failed: ${
            e instanceof Error ? e.message : e
          }`,
        );
        if (signal?.aborted) return makeAbortResult();
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          phase: "container",
          partial,
        };
      }

      // Check abort before agent loop
      if (signal?.aborted) return makeAbortResult();

      // Run the agent loop
      log.debug(`[knox] Starting agent loop phase...`);
      let agentResult: {
        completed: boolean;
        loopsRun: number;
        autoCommitted: boolean;
      };
      try {
        log.info(`Starting agent loop (max ${maxLoops} loops)...`);
        const provider = new ClaudeCodeAgentProvider(model);
        const containerHandle = session.toContainerHandle();
        const agentRunner = new AgentRunner({
          provider,
          container: containerHandle,
          task,
          maxLoops,
          checkCommand: check,
          customPrompt,
          onLine,
          onEvent: emit,
          signal,
        });
        agentResult = await agentRunner.run();
        log.debug(
          `[knox] Agent loop finished: completed=${agentResult.completed} loops=${agentResult.loopsRun} autoCommitted=${agentResult.autoCommitted}`,
        );
      } catch (e) {
        log.debug(
          `[knox] Agent loop failed: ${e instanceof Error ? e.message : e}`,
        );
        if (e instanceof Error && e.stack) {
          log.debug(`[knox] Stack: ${e.stack}`);
        }
        if (signal?.aborted) return makeAbortResult();
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          phase: "agent",
          partial,
        };
      }

      partial.loopsRun = agentResult.loopsRun;
      partial.autoCommitted = agentResult.autoCommitted;
      partial.completed = agentResult.completed;

      // Check abort before bundle
      if (signal?.aborted) return makeAbortResult();

      // Create git bundle and copy to host
      log.debug(`[knox] Starting bundle phase...`);
      let bundlePath: string;
      try {
        log.info(`Creating git bundle...`);
        bundlePath = await session.extractBundle();
        log.debug(`[knox] Bundle extracted: ${bundlePath}`);
        emit({ type: "bundle:extracted", path: bundlePath });
      } catch (e) {
        log.debug(
          `[knox] Bundle failed: ${e instanceof Error ? e.message : e}`,
        );
        if (signal?.aborted) return makeAbortResult();
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          phase: "bundle",
          partial,
        };
      }

      // Check abort before sink
      if (signal?.aborted) return makeAbortResult();

      // Collect result via sink
      log.debug(`[knox] Starting sink phase...`);
      let sinkResult: SinkResult;
      try {
        log.info(`Extracting results...`);
        const slug = taskSlug(task);
        log.debug(`[knox] Task slug: ${slug}`);
        sinkResult = await resultSink.collect({
          runId,
          bundlePath,
          metadata: session.metadata,
          taskSlug: slug,
          autoCommitted: agentResult.autoCommitted,
          branchName: this.options.branchName,
        });
        log.debug(`[knox] Sink collected: strategy=${sinkResult.strategy}`);
        await resultSink.cleanup(runId);
        log.debug(`[knox] Sink cleanup done`);
      } catch (e) {
        log.debug(`[knox] Sink failed: ${e instanceof Error ? e.message : e}`);
        if (signal?.aborted) return makeAbortResult();
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          phase: "sink",
          partial,
        };
      }

      // Derive checkPassed
      const checkPassed = check == null
        ? null
        : agentResult.completed
        ? true
        : false;

      const finishedAt = new Date().toISOString();
      const durationMs = new Date(finishedAt).getTime() -
        new Date(startedAt).getTime();

      if (agentResult.completed) {
        log.info(`Task completed in ${agentResult.loopsRun} loop(s).`);
      } else {
        log.info(`Max loops (${maxLoops}) reached.`);
      }

      return {
        ok: true,
        result: {
          runId,
          completed: agentResult.completed,
          aborted: false,
          loopsRun: agentResult.loopsRun,
          maxLoops,
          startedAt,
          difficulty,
          finishedAt,
          durationMs,
          model,
          task,
          autoCommitted: agentResult.autoCommitted,
          checkPassed,
          sink: sinkResult,
        },
      };
    } finally {
      // Remove abort listener before dispose to prevent double-dispose
      if (onAbort) {
        signal?.removeEventListener("abort", onAbort);
      }
      if (session) {
        await session.dispose();
      }
      // Clean up run temp directory
      await Deno.remove(runDir, { recursive: true }).catch(() => {});
      log.info(`Done.`);
    }
  }
}
