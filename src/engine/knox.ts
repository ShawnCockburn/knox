import type { ContainerRuntime } from "../shared/runtime/container_runtime.ts";
import { DockerRuntime } from "../shared/runtime/docker_runtime.ts";
import { AgentRunner } from "./agent/agent_runner.ts";
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

export interface KnoxEngineOptions {
  task: string;
  dir: string;
  image: ImageId;
  envVars: string[];
  allowedIPs: string[];
  runId?: RunId;
  maxLoops?: number;
  model?: string;
  customPrompt?: string;
  check?: string;
  cpuLimit?: string;
  memoryLimit?: string;
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
      customPrompt,
      check,
      cpuLimit,
      memoryLimit,
      onLine,
      onEvent,
      signal,
    } = this.options;

    const emit = (event: KnoxEvent) => onEvent?.(event);

    // Create run temp directory
    await Deno.mkdir(runDir, { recursive: true });

    const sourceProvider = this.options.sourceProvider ??
      new GitSourceProvider(dir);
    const resultSink = this.options.resultSink ?? new GitBranchSink(dir);

    let session: ContainerSession | undefined;

    const partial: Partial<KnoxResult> = {
      runId,
      task,
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
        });
        emit({ type: "container:created", containerId: session.containerId });
      } catch (e) {
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
      let agentResult: {
        completed: boolean;
        loopsRun: number;
        autoCommitted: boolean;
      };
      try {
        log.info(`Starting agent loop (max ${maxLoops} loops)...`);
        const agentRunner = new AgentRunner({
          session,
          model,
          task,
          maxLoops,
          checkCommand: check,
          customPrompt,
          onLine,
          onEvent: emit,
          signal,
        });
        agentResult = await agentRunner.run();
      } catch (e) {
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
      let bundlePath: string;
      try {
        log.info(`Creating git bundle...`);
        bundlePath = await session.extractBundle();
        emit({ type: "bundle:extracted", path: bundlePath });
      } catch (e) {
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
      let sinkResult: SinkResult;
      try {
        log.info(`Extracting results...`);
        const slug = taskSlug(task);
        sinkResult = await resultSink.collect({
          runId,
          bundlePath,
          metadata: session.metadata,
          taskSlug: slug,
          autoCommitted: agentResult.autoCommitted,
          branchName: this.options.branchName,
        });
        await resultSink.cleanup(runId);
      } catch (e) {
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
      if (session) {
        await session.dispose();
      }
      // Clean up run temp directory
      await Deno.remove(runDir, { recursive: true }).catch(() => {});
      log.info(`Done.`);
    }
  }
}
