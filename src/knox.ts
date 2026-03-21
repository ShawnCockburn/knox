import type { ContainerRuntime } from "./runtime/container_runtime.ts";
import { DockerRuntime } from "./runtime/docker_runtime.ts";
import { ImageManager } from "./image/image_manager.ts";
import { LoopExecutor } from "./loop/loop_executor.ts";
import { ResultExtractor, taskSlug } from "./result/result_extractor.ts";
import { PreflightChecker } from "./preflight/preflight_checker.ts";
import type { ContainerId } from "./types.ts";

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
}

export interface KnoxResult {
  completed: boolean;
  loopsRun: number;
  branchName?: string;
  commitCount: number;
}

export class Knox {
  private options: KnoxOptions;
  private runtime: ContainerRuntime;

  constructor(options: KnoxOptions) {
    this.options = options;
    this.runtime = options.runtime ?? new DockerRuntime();
  }

  async run(): Promise<KnoxResult> {
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

    // Preflight checks
    if (!this.options.skipPreflight) {
      const preflight = new PreflightChecker();
      const preflightResult = await preflight.check({
        runtime: this.runtime,
        sourceDir: dir,
        envVars: env,
      });

      for (const warning of preflightResult.warnings) {
        console.error(`[knox] Warning: ${warning}`);
      }

      if (!preflightResult.ok) {
        for (const error of preflightResult.errors) {
          console.error(`[knox] Error: ${error}`);
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
    console.error(`[knox] Ensuring agent image...`);
    const image = await imageManager.ensureSetupImage(setup);
    console.error(`[knox] Image ready: ${image}`);

    // Create air-gapped container
    console.error(`[knox] Creating container (network disabled)...`);
    const envVars = [
      ...env,
      `ANTHROPIC_API_KEY=${Deno.env.get("ANTHROPIC_API_KEY") ?? ""}`,
    ];
    let containerId: ContainerId | undefined;

    // Register signal handler for cleanup on interrupt
    const onSignal = () => {
      if (containerId) {
        console.error(`\n[knox] Interrupted. Cleaning up container...`);
        this.runtime.remove(containerId).catch(() => {}).finally(() => {
          Deno.exit(130);
        });
      } else {
        Deno.exit(130);
      }
    };
    Deno.addSignalListener("SIGINT", onSignal);

    try {
      containerId = await this.runtime.createContainer({
        image,
        workdir: "/workspace",
        env: envVars,
        networkEnabled: false,
        cpuLimit,
        memoryLimit,
      });
      console.error(`[knox] Container: ${containerId}`);

      // Copy source into container
      console.error(`[knox] Copying source into container...`);
      await this.runtime.copyIn(containerId, dir, "/workspace");

      // Initialize git inside container if needed, record initial commit
      await this.runtime.exec(containerId, [
        "sh",
        "-c",
        "cd /workspace && (git rev-parse --git-dir 2>/dev/null || (git init && git add -A && git commit -m 'initial' --allow-empty))",
      ]);

      const headResult = await this.runtime.exec(
        containerId,
        ["git", "rev-parse", "HEAD"],
        { workdir: "/workspace" },
      );
      const initialCommit = headResult.stdout.trim();

      // Run the loop
      console.error(`[knox] Starting agent loop (max ${maxLoops} loops)...`);
      const executor = new LoopExecutor({
        runtime: this.runtime,
        containerId,
        model,
        task,
        maxLoops,
        checkCommand: check,
        customPrompt,
        onLine,
      });
      const loopResult = await executor.run();

      // Extract results
      console.error(`[knox] Extracting results...`);
      const slug = taskSlug(task);
      const extractor = new ResultExtractor();
      const extractResult = await extractor.extract({
        runtime: this.runtime,
        containerId,
        hostDir: dir,
        taskSlug: slug,
        initialCommit,
      });

      if (loopResult.completed) {
        console.error(
          `[knox] Task completed in ${loopResult.loopsRun} loop(s). Branch: ${extractResult.branchName}`,
        );
      } else {
        console.error(
          `[knox] Max loops (${maxLoops}) reached. Partial results on: ${extractResult.branchName}`,
        );
      }

      return {
        completed: loopResult.completed,
        loopsRun: loopResult.loopsRun,
        branchName: extractResult.branchName,
        commitCount: extractResult.commitCount,
      };
    } finally {
      Deno.removeSignalListener("SIGINT", onSignal);
      if (containerId) {
        console.error(`[knox] Cleaning up container...`);
        await this.runtime.remove(containerId);
        console.error(`[knox] Done.`);
      }
    }
  }
}
