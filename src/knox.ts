import type { ContainerRuntime } from "./runtime/container_runtime.ts";
import { DockerRuntime } from "./runtime/docker_runtime.ts";
import { ImageManager } from "./image/image_manager.ts";
import { AgentRunner } from "./agent/agent_runner.ts";
import { PreflightChecker } from "./preflight/preflight_checker.ts";
import { ContainerSession } from "./session/container_session.ts";
import { resolveAuth } from "./knox/resolve_auth.ts";
import { resolveAllowedIPs } from "./knox/resolve_network.ts";
import { generateRunId, taskSlug } from "./types.ts";
import type { SourceProvider } from "./source/source_provider.ts";
import { GitSourceProvider } from "./source/git_source_provider.ts";
import type { ResultSink, SinkResult } from "./sink/result_sink.ts";
import { GitBranchSink } from "./sink/git_branch_sink.ts";
import { log } from "./log.ts";

export interface KnoxOptions {
  task: string;
  dir: string;
  maxLoops?: number;
  model?: string;
  setup?: string;
  env?: string[];
  promptPath?: string;
  check?: string;
  cpuLimit?: string;
  memoryLimit?: string;
  onLine?: (line: string) => void;
  runtime?: ContainerRuntime;
  skipPreflight?: boolean;
  sourceProvider?: SourceProvider;
  resultSink?: ResultSink;
}

export interface KnoxResult {
  completed: boolean;
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

export class Knox {
  private options: KnoxOptions;
  private runtime: ContainerRuntime;

  constructor(options: KnoxOptions) {
    this.options = options;
    this.runtime = options.runtime ?? new DockerRuntime();
  }

  async run(): Promise<KnoxResult> {
    const startedAt = new Date().toISOString();
    const runId = generateRunId();
    const runDir = `/tmp/knox-${runId}`;

    const {
      task,
      dir,
      maxLoops = 10,
      model = "sonnet",
      setup,
      env = [],
      check,
      cpuLimit,
      memoryLimit,
      onLine,
    } = this.options;

    // Create run temp directory
    await Deno.mkdir(runDir, { recursive: true });

    const sourceProvider = this.options.sourceProvider ??
      new GitSourceProvider(dir);
    const resultSink = this.options.resultSink ?? new GitBranchSink(dir);

    let session: ContainerSession | undefined;

    const onSignal = () => {
      if (session) {
        log.info(`\nInterrupted. Cleaning up container...`);
        session.dispose().catch(() => {}).finally(() => {
          Deno.exit(130);
        });
      } else {
        Deno.exit(130);
      }
    };
    Deno.addSignalListener("SIGINT", onSignal);

    try {
      // Preflight checks
      if (!this.options.skipPreflight) {
        const preflight = new PreflightChecker();
        const preflightResult = await preflight.check({
          runtime: this.runtime,
          sourceDir: dir,
          envVars: env,
        });

        for (const warning of preflightResult.warnings) {
          log.warn(warning);
        }

        if (!preflightResult.ok) {
          for (const error of preflightResult.errors) {
            log.error(error);
          }
          throw new Error("Preflight checks failed");
        }
      }

      // Load custom prompt
      let customPrompt: string | undefined;
      if (this.options.promptPath) {
        customPrompt = await Deno.readTextFile(this.options.promptPath);
      }

      // Build/cache images
      const imageManager = new ImageManager(this.runtime);
      log.info(`Ensuring agent image...`);
      const image = await imageManager.ensureSetupImage(setup);
      log.debug(`Image ready: ${image}`);

      // Resolve authentication
      const envVars = await resolveAuth(env);

      // Resolve Anthropic API IPs for network restriction
      const allowedIPs = await resolveAllowedIPs();

      // Create sandboxed container session
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

      // Run the agent loop
      log.info(`Starting agent loop (max ${maxLoops} loops)...`);
      const agentRunner = new AgentRunner({
        session,
        model,
        task,
        maxLoops,
        checkCommand: check,
        customPrompt,
        onLine,
      });
      const agentResult = await agentRunner.run();

      // Create git bundle and copy to host
      log.info(`Creating git bundle...`);
      const bundlePath = await session.extractBundle();

      // Collect result via sink
      log.info(`Extracting results...`);
      const slug = taskSlug(task);
      const sinkResult = await resultSink.collect({
        runId,
        bundlePath,
        metadata: session.metadata,
        taskSlug: slug,
        autoCommitted: agentResult.autoCommitted,
      });
      await resultSink.cleanup(runId);

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
        completed: agentResult.completed,
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
      };
    } finally {
      Deno.removeSignalListener("SIGINT", onSignal);
      if (session) {
        await session.dispose();
      }
      // Clean up run temp directory
      await Deno.remove(runDir, { recursive: true }).catch(() => {});
      log.info(`Done.`);
    }
  }
}
