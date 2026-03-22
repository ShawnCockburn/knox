import type { ContainerRuntime } from "./runtime/container_runtime.ts";
import { DockerRuntime } from "./runtime/docker_runtime.ts";
import { ImageManager } from "./image/image_manager.ts";
import { LoopExecutor } from "./loop/loop_executor.ts";
import { PreflightChecker } from "./preflight/preflight_checker.ts";
import { CredentialError, getCredential } from "./auth/mod.ts";
import { generateRunId, taskSlug } from "./types.ts";
import type { ContainerId } from "./types.ts";
import type { SourceProvider } from "./source/source_provider.ts";
import { GitSourceProvider } from "./source/git_source_provider.ts";
import type { ResultSink, SinkResult } from "./sink/result_sink.ts";
import { GitBranchSink } from "./sink/git_branch_sink.ts";
import { log } from "./log.ts";

const WORKSPACE = "/workspace";

const COMMIT_NUDGE_PROMPT =
  `You have uncommitted changes in the workspace. Review \`git diff\` and \`git status\`, then commit all changes with a meaningful conventional commit message (e.g., feat:, fix:, refactor:). Do NOT make any further code changes — only commit.`;

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

    let containerId: ContainerId | undefined;

    const onSignal = () => {
      if (containerId) {
        log.info(`\nInterrupted. Cleaning up container...`);
        this.runtime.remove(containerId).catch(() => {}).finally(() => {
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
      log.info(`Resolving authentication...`);
      const envVars = [...env];
      const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
      try {
        const credential = await getCredential();
        envVars.push(`CLAUDE_CODE_OAUTH_TOKEN=${credential.accessToken}`);
        log.debug(`Using OAuth credential for authentication`);
      } catch (e) {
        if (e instanceof CredentialError) {
          if (apiKey) {
            envVars.push(`ANTHROPIC_API_KEY=${apiKey}`);
            log.debug(`Using ANTHROPIC_API_KEY for authentication`);
          }
        } else {
          throw e;
        }
      }

      // Resolve Anthropic API IPs for network restriction
      log.info(`Resolving API endpoints...`);
      const allowedIPs = await this.resolveAllowedIPs();
      log.debug(`Allowed IPs: ${allowedIPs.join(", ")}`);

      // Prepare source
      log.info(`Preparing source...`);
      const prepareResult = await sourceProvider.prepare(runId);
      for (const warning of prepareResult.warnings ?? []) {
        log.warn(warning);
      }

      // Create container
      log.info(`Creating container (API-only network)...`);
      containerId = await this.runtime.createContainer({
        image,
        name: `knox-${runId}`,
        workdir: WORKSPACE,
        env: envVars,
        networkEnabled: true,
        capAdd: ["NET_ADMIN"],
        cpuLimit,
        memoryLimit,
      });
      log.debug(`Container: ${containerId}`);

      // Copy source into container and fix ownership
      log.info(`Copying source into container...`);
      await this.runtime.copyIn(
        containerId,
        prepareResult.hostPath + "/.",
        WORKSPACE,
      );
      await this.runtime.exec(
        containerId,
        ["chown", "-R", "knox:knox", WORKSPACE],
        { user: "root" },
      );

      // Cleanup source temp files
      await sourceProvider.cleanup(runId);

      // Lock down network to API-only egress
      await this.runtime.restrictNetwork(containerId, allowedIPs);
      log.debug(`Network restricted to API endpoints only`);

      // Verify git repo exists in workspace (source provider must supply .git)
      const gitCheck = await this.runtime.exec(containerId, [
        "sh",
        "-c",
        `cd ${WORKSPACE} && git rev-parse --git-dir`,
      ]);
      if (gitCheck.exitCode !== 0) {
        throw new Error(
          "No .git directory in workspace after source copy — aborting",
        );
      }

      // Exclude knox internal files from agent commits (via .git/info/exclude so it never leaks)
      await this.runtime.exec(containerId, [
        "sh",
        "-c",
        `cd ${WORKSPACE} && printf 'knox-progress.txt\\n.knox/\\n' >> .git/info/exclude`,
      ]);

      // Run the agent loop
      log.info(`Starting agent loop (max ${maxLoops} loops)...`);
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

      // Commit nudge: handle uncommitted agent work
      let autoCommitted = false;
      const statusResult = await this.runtime.exec(
        containerId,
        ["git", "status", "--porcelain"],
        { workdir: WORKSPACE },
      );
      const hasDirtyFiles = statusResult.stdout.trim().length > 0;

      if (hasDirtyFiles) {
        log.info(`Agent left uncommitted changes. Nudging to commit...`);
        // Nudge: run claude one more time with a narrow commit-only prompt
        try {
          await this.runtime.execStream(
            containerId,
            [
              "sh",
              "-c",
              `echo '${
                COMMIT_NUDGE_PROMPT.replace(/'/g, "'\\''")
              }' | claude -p --dangerously-skip-permissions --model ${model}`,
            ],
            {
              workdir: WORKSPACE,
              onLine: (line, stream) => {
                if (stream === "stdout") onLine?.(line);
              },
            },
          );
        } catch {
          // Nudge failed — fall through to mechanical auto-commit
        }

        // Check if still dirty after nudge
        const postNudge = await this.runtime.exec(
          containerId,
          ["git", "status", "--porcelain"],
          { workdir: WORKSPACE },
        );
        if (postNudge.stdout.trim().length > 0) {
          log.info(`Nudge did not produce a commit. Auto-committing...`);
          await this.runtime.exec(
            containerId,
            [
              "sh",
              "-c",
              `cd ${WORKSPACE} && git add -A && git commit -m "knox: auto-commit uncommitted agent work"`,
            ],
          );
          autoCommitted = true;
        }
      }

      // Create git bundle inside container
      log.info(`Creating git bundle...`);
      const bundleResult = await this.runtime.exec(
        containerId,
        ["git", "bundle", "create", "/tmp/knox.bundle", "HEAD"],
        { workdir: WORKSPACE },
      );
      if (bundleResult.exitCode !== 0) {
        throw new Error(`git bundle create failed: ${bundleResult.stderr}`);
      }

      // Copy bundle out to run directory
      const bundlePath = `${runDir}/bundle.git`;
      await this.runtime.copyOut(containerId, "/tmp/knox.bundle", bundlePath);

      // Collect result via sink
      log.info(`Extracting results...`);
      const slug = taskSlug(task);
      const sinkResult = await resultSink.collect({
        runId,
        bundlePath,
        metadata: prepareResult.metadata,
        taskSlug: slug,
        autoCommitted,
      });
      await resultSink.cleanup(runId);

      // Derive checkPassed
      const checkPassed = check == null
        ? null
        : loopResult.completed
        ? true
        : false;

      const finishedAt = new Date().toISOString();
      const durationMs = new Date(finishedAt).getTime() -
        new Date(startedAt).getTime();

      if (loopResult.completed) {
        log.info(`Task completed in ${loopResult.loopsRun} loop(s).`);
      } else {
        log.info(`Max loops (${maxLoops}) reached.`);
      }

      return {
        completed: loopResult.completed,
        loopsRun: loopResult.loopsRun,
        maxLoops,
        startedAt,
        finishedAt,
        durationMs,
        model,
        task,
        autoCommitted,
        checkPassed,
        sink: sinkResult,
      };
    } finally {
      Deno.removeSignalListener("SIGINT", onSignal);
      if (containerId) {
        log.info(`Cleaning up container...`);
        await this.runtime.remove(containerId);
      }
      // Clean up run temp directory
      await Deno.remove(runDir, { recursive: true }).catch(() => {});
      log.info(`Done.`);
    }
  }
}
