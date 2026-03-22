import type { ContainerRuntime } from "./runtime/container_runtime.ts";
import { DockerRuntime } from "./runtime/docker_runtime.ts";
import { ImageManager } from "./image/image_manager.ts";
import { LoopExecutor } from "./loop/loop_executor.ts";
import { ResultExtractor, taskSlug } from "./result/result_extractor.ts";
import { PreflightChecker } from "./preflight/preflight_checker.ts";
import { getCredential, CredentialError } from "./auth/mod.ts";
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

  private async resolveAllowedIPs(): Promise<string[]> {
    const hosts = [
      "api.anthropic.com",
      "statsigapi.net",
      "http-intake.logs.us5.datadoghq.com",
      "sentry.io",
    ];
    const ips = new Set<string>();
    for (const host of hosts) {
      try {
        const records = await Deno.resolveDns(host, "A");
        for (const ip of records) ips.add(ip);
      } catch {
        // Fall back to a manual lookup via subprocess if Deno DNS fails
        const cmd = new Deno.Command("dig", {
          args: ["+short", host, "A"],
          stdout: "piped",
          stderr: "null",
        });
        const output = await cmd.output();
        const lines = new TextDecoder().decode(output.stdout).trim().split(
          "\n",
        );
        for (const line of lines) {
          if (/^\d+\.\d+\.\d+\.\d+$/.test(line)) ips.add(line);
        }
      }
    }
    if (ips.size === 0) {
      throw new Error(
        "Failed to resolve Anthropic API IPs — cannot set up network restriction",
      );
    }
    return [...ips];
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

    // Resolve authentication
    console.error(`[knox] Resolving authentication...`);
    const envVars = [...env];
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    try {
      const credential = await getCredential();
      envVars.push(`CLAUDE_CODE_OAUTH_TOKEN=${credential.accessToken}`);
      console.error(`[knox] Using OAuth credential for authentication`);
    } catch (e) {
      if (e instanceof CredentialError) {
        if (apiKey) {
          envVars.push(`ANTHROPIC_API_KEY=${apiKey}`);
          console.error(`[knox] Using ANTHROPIC_API_KEY for authentication`);
        }
      } else {
        throw e;
      }
    }

    // Resolve Anthropic API IPs for network restriction
    console.error(`[knox] Resolving API endpoints...`);
    const allowedIPs = await this.resolveAllowedIPs();
    console.error(`[knox] Allowed IPs: ${allowedIPs.join(", ")}`);

    // Create container with restricted network (API-only egress)
    console.error(`[knox] Creating container (API-only network)...`);
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
        networkEnabled: true,
        capAdd: ["NET_ADMIN"],
        cpuLimit,
        memoryLimit,
      });
      console.error(`[knox] Container: ${containerId}`);

      // Copy source into container and fix ownership
      console.error(`[knox] Copying source into container...`);
      await this.runtime.copyIn(containerId, dir, "/workspace");
      await this.runtime.exec(
        containerId,
        ["chown", "-R", "knox:knox", "/workspace"],
        { user: "root" },
      );

      // Lock down network to API-only egress
      await this.runtime.restrictNetwork(containerId, allowedIPs);
      console.error(`[knox] Network restricted to API endpoints only`);

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
