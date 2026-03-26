import { parseArgs } from "@std/cli";
import { basename, dirname, resolve } from "@std/path";
import { Knox } from "../engine/knox.ts";
import { formatSummary } from "./format.ts";
import { log } from "../shared/log.ts";
import { PreflightChecker } from "../shared/preflight/preflight_checker.ts";
import { ImageManager } from "../shared/image/image_manager.ts";
import { DockerRuntime } from "../shared/runtime/docker_runtime.ts";
import { resolveAuth } from "../shared/knox/resolve_auth.ts";
import { resolveAllowedIPs } from "../shared/knox/resolve_network.ts";
import { FileQueueSource } from "../queue/file_queue_source.ts";
import {
  Orchestrator,
  OrchestratorValidationError,
} from "../queue/orchestrator.ts";
import { StaticRenderer } from "../queue/tui/static_renderer.ts";
import { QueueTUI } from "../queue/tui/queue_tui.ts";
import { resolveConfig } from "../queue/config.ts";
import { DirectoryQueueSource } from "../queue/directory_queue_source.ts";
import { discoverQueues } from "../queue/queue_discovery.ts";
import {
  BranchQueueOutput,
  createSinglePR,
  PullRequestQueueOutput,
} from "../queue/output.ts";
import type { QueueOutput } from "../queue/output.ts";
import { MultiQueueRunner } from "../queue/multi_queue_runner.ts";

const USAGE = `Usage: knox <command> [options]

Commands:
  run      Run a single task in a sandboxed container
  queue    Run a queue of tasks from a YAML manifest

Run 'knox <command> --help' for command-specific usage.`;

const RUN_USAGE = `Usage: knox run --task <task> [options]

Options:
  --task <task>       Task description (required)
  --dir <dir>         Source directory (default: .)
  --model <model>     Claude model (default: sonnet)
  --setup <cmd>       Setup command to run with network (e.g., "npm install")
  --check <cmd>       Verification command (e.g., "npm test")
  --max-loops <n>     Maximum loop iterations (default: 10)
  --env KEY=VALUE     Environment variable (repeatable)
  --prompt <path>     Custom prompt file
  --cpu <limit>       CPU limit (e.g., "2")
  --memory <limit>    Memory limit (e.g., "4g")
  --output <strategy> Output strategy: "branch" or "pr" (overrides .knox/config.yaml)
  --skip-preflight    Skip preflight checks
  --verbose           Show debug-level messages
  --quiet             Suppress info messages (show warnings and errors only)`;

const QUEUE_USAGE = `Usage: knox queue [options]

Options:
  --file <path>       Queue YAML file (existing behavior)
  --name <name>       Run a specific queue from .knox/queues/<name>/
  --output <strategy> Output strategy: "branch" or "pr" (overrides .knox/config.yaml)
  --resume            Resume from last checkpoint
  --verbose           Show debug-level messages
  --no-tui            Disable live TUI`;

// Detect subcommand
const subcommand = Deno.args[0];
const subcommandArgs = Deno.args.slice(1);

// Support legacy mode: if first arg looks like a flag, treat as implicit "run"
const isFlag = subcommand?.startsWith("-");
const effectiveCommand = (!subcommand || isFlag) ? null : subcommand;
const effectiveArgs = isFlag ? Deno.args : subcommandArgs;

if (effectiveCommand === "queue") {
  const flags = parseArgs(effectiveArgs, {
    string: ["file", "name", "output"],
    boolean: ["resume", "verbose", "no-tui", "help"],
  });

  if (flags.help) {
    console.error(QUEUE_USAGE);
    Deno.exit(0);
  }

  if (flags.verbose) {
    log.setLevel("debug");
  }

  const projectDir = resolve(".");

  // Load project config and resolve effective output strategy
  const config = await resolveConfig(projectDir);
  const outputStrategy = (flags.output as string | undefined) ??
    config.output ??
    "branch";

  const queueOutput: QueueOutput = outputStrategy === "pr"
    ? new PullRequestQueueOutput({
      draft: config.pr?.draft,
      base: config.pr?.base,
    })
    : new BranchQueueOutput();

  const isTTY = Deno.stderr.isTerminal();
  const isVerbose = flags.verbose as boolean;
  const useTUI = isTTY && !flags["no-tui"];

  if (flags.file) {
    // ── File mode (existing behaviour) ──────────────────────────────────────
    const queueFilePath = resolve(flags.file as string);
    try {
      await Deno.stat(queueFilePath);
    } catch {
      console.error(`Error: queue file not found: ${queueFilePath}`);
      Deno.exit(2);
    }

    const runtime = new DockerRuntime();

    try {
      const source = new FileQueueSource(queueFilePath);
      const loadResult = await source.load();
      if (!loadResult.ok) {
        for (const err of loadResult.errors) {
          log.error(err.message);
        }
        Deno.exit(2);
      }
      const manifest = loadResult.manifest;

      log.info("Resolving shared resources...");
      const imageManager = new ImageManager(runtime);
      const image = await imageManager.ensureSetupImage(
        manifest.defaults?.setup,
      );
      const resolvedEnvVars = await resolveAuth([]);
      const allowedIPs = await resolveAllowedIPs();

      const queueName = basename(queueFilePath).replace(/\.ya?ml$/, "");
      const logDir = resolve(dirname(queueFilePath), `${queueName}.logs`);

      const itemIds = manifest.items.map((i) => i.id);
      let renderer: StaticRenderer | QueueTUI;
      if (useTUI) {
        renderer = new QueueTUI(itemIds, {
          verbose: isVerbose,
          queueName,
        });
      } else {
        renderer = new StaticRenderer({ verbose: isVerbose });
      }

      const controller = new AbortController();
      Deno.addSignalListener("SIGINT", () => {
        controller.abort();
        renderer.setAborting();
        if (!useTUI) {
          log.info(`\nInterrupted. Aborting queue...`);
        }
      });

      if (useTUI) log.mute();
      renderer.start();

      const orchestrator = new Orchestrator({
        source,
        image,
        envVars: resolvedEnvVars,
        allowedIPs,
        dir: projectDir,
        logDir,
        signal: controller.signal,
        resume: flags.resume as boolean,
        verbose: isVerbose,
        suppressSummary: true,
        runtime,
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

      // Run post-queue output handler
      await queueOutput.onQueueComplete(report);

      console.log(JSON.stringify(report, null, 2));

      const allCompleted = report.items.every((i) => i.status === "completed");
      Deno.exit(allCompleted ? 0 : 1);
    } catch (e) {
      if (e instanceof OrchestratorValidationError) {
        for (const err of e.errors) {
          log.error(err.message);
        }
        Deno.exit(2);
      }
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`Fatal: ${msg}`);
      Deno.exit(3);
    }
  } else if (flags.name) {
    // ── Named queue mode ─────────────────────────────────────────────────────
    const queueDir = resolve(projectDir, ".knox", "queues", flags.name as string);
    try {
      await Deno.stat(queueDir);
    } catch {
      console.error(
        `Error: queue not found: .knox/queues/${flags.name}/`,
      );
      Deno.exit(2);
    }

    const runtime = new DockerRuntime();

    try {
      const source = new DirectoryQueueSource(queueDir);
      const loadResult = await source.load();
      if (!loadResult.ok) {
        for (const err of loadResult.errors) {
          log.error(err.message);
        }
        Deno.exit(2);
      }
      const manifest = loadResult.manifest;

      log.info("Resolving shared resources...");
      const imageManager = new ImageManager(runtime);
      const image = await imageManager.ensureSetupImage(
        manifest.defaults?.setup,
      );
      const resolvedEnvVars = await resolveAuth([]);
      const allowedIPs = await resolveAllowedIPs();

      const queueName = flags.name as string;
      const logDir = resolve(queueDir, ".logs");

      const itemIds = manifest.items.map((i) => i.id);
      let renderer: StaticRenderer | QueueTUI;
      if (useTUI) {
        renderer = new QueueTUI(itemIds, { verbose: isVerbose, queueName });
      } else {
        renderer = new StaticRenderer({ verbose: isVerbose });
      }

      const controller = new AbortController();
      Deno.addSignalListener("SIGINT", () => {
        controller.abort();
        renderer.setAborting();
        if (!useTUI) {
          log.info(`\nInterrupted. Aborting queue...`);
        }
      });

      if (useTUI) log.mute();
      renderer.start();

      const orchestrator = new Orchestrator({
        source,
        image,
        envVars: resolvedEnvVars,
        allowedIPs,
        dir: projectDir,
        logDir,
        signal: controller.signal,
        resume: flags.resume as boolean,
        verbose: isVerbose,
        suppressSummary: true,
        runtime,
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
      await queueOutput.onQueueComplete(report);
      console.log(JSON.stringify(report, null, 2));

      const allCompleted = report.items.every((i) => i.status === "completed");
      Deno.exit(allCompleted ? 0 : 1);
    } catch (e) {
      if (e instanceof OrchestratorValidationError) {
        for (const err of e.errors) {
          log.error(err.message);
        }
        Deno.exit(2);
      }
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`Fatal: ${msg}`);
      Deno.exit(3);
    }
  } else {
    // ── Discovery mode ───────────────────────────────────────────────────────
    const discovered = await discoverQueues(projectDir);
    if (discovered.length === 0) {
      console.error(
        `Error: no queues found in ${projectDir}/.knox/queues/`,
      );
      console.error(
        "Create a queue directory with .md task files, or use --file or --name.",
      );
      Deno.exit(2);
    }

    const queueDirs = discovered.map((q) => q.path);
    log.info(`Discovered ${discovered.length} queue(s).`);

    const runtime = new DockerRuntime();
    log.info("Resolving shared resources...");
    const imageManager = new ImageManager(runtime);
    const image = await imageManager.ensureSetupImage(undefined);
    const resolvedEnvVars = await resolveAuth([]);
    const allowedIPs = await resolveAllowedIPs();

    const controller = new AbortController();
    Deno.addSignalListener("SIGINT", () => {
      controller.abort();
      if (!useTUI) {
        log.info(`\nInterrupted. Aborting queues...`);
      }
    });

    const runner = new MultiQueueRunner({
      queueDirs,
      image,
      envVars: resolvedEnvVars,
      allowedIPs,
      dir: projectDir,
      signal: controller.signal,
      resume: flags.resume as boolean,
      verbose: isVerbose,
      useTUI,
      runtime,
      output: queueOutput,
    });

    try {
      const multiReport = await runner.run();
      MultiQueueRunner.printCombinedSummary(multiReport);

      const allReports = multiReport.queues.map((q) => q.report);
      console.log(JSON.stringify(allReports, null, 2));

      const allCompleted = allReports.every((r) =>
        r.items.every((i) => i.status === "completed")
      );
      Deno.exit(allCompleted ? 0 : 1);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`Fatal: ${msg}`);
      Deno.exit(3);
    }
  }
} else if (effectiveCommand === "run" || effectiveCommand === null) {
  // "knox run" or legacy "knox --task ..."
  if (effectiveCommand === null && !subcommand) {
    // No subcommand and no flags — print top-level usage
    console.error(USAGE);
    Deno.exit(2);
  }

  const flags = parseArgs(effectiveArgs, {
    string: [
      "task",
      "dir",
      "model",
      "setup",
      "prompt",
      "check",
      "max-loops",
      "cpu",
      "memory",
      "output",
    ],
    boolean: ["verbose", "quiet", "skip-preflight", "help"],
    collect: ["env"],
    default: { dir: ".", model: "sonnet", "max-loops": "10" },
  });

  if (flags.verbose && flags.quiet) {
    console.error("Error: --verbose and --quiet are mutually exclusive");
    Deno.exit(2);
  }

  if (flags.verbose) {
    log.setLevel("debug");
  } else if (flags.quiet) {
    log.setLevel("warn");
  }

  if (flags.help || !flags.task) {
    console.error(RUN_USAGE);
    Deno.exit(2);
  }

  const maxLoops = parseInt(flags["max-loops"] as string, 10);
  if (isNaN(maxLoops) || maxLoops < 1) {
    console.error("Error: --max-loops must be a positive integer");
    Deno.exit(2);
  }

  // Validate --env format
  const envVars = (flags.env as string[] | undefined) ?? [];
  for (const e of envVars) {
    if (!e.includes("=")) {
      console.error(
        `Error: --env value must be in KEY=VALUE format, got: ${e}`,
      );
      Deno.exit(2);
    }
  }

  const dir = resolve(flags.dir as string);
  const runtime = new DockerRuntime();

  // Load project config and resolve effective output strategy
  const config = await resolveConfig(dir);
  const outputStrategy = (flags.output as string | undefined) ??
    config.output ??
    "branch";

  try {
    // Pre-container setup (CLI responsibility)

    // 1. Preflight checks
    if (!flags["skip-preflight"]) {
      const preflight = new PreflightChecker();
      const preflightResult = await preflight.check({
        runtime,
        sourceDir: dir,
        envVars,
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

    // 2. Build/cache images
    const imageManager = new ImageManager(runtime);
    log.info(`Ensuring agent image...`);
    const image = await imageManager.ensureSetupImage(
      flags.setup as string | undefined,
    );
    log.debug(`Image ready: ${image}`);

    // 3. Resolve authentication
    const resolvedEnvVars = await resolveAuth(envVars);

    // 4. Resolve Anthropic API IPs for network restriction
    const allowedIPs = await resolveAllowedIPs();

    // 5. Load custom prompt
    let customPrompt: string | undefined;
    if (flags.prompt) {
      customPrompt = await Deno.readTextFile(flags.prompt as string);
    }

    // Wire SIGINT to AbortController
    const controller = new AbortController();
    Deno.addSignalListener("SIGINT", () => {
      log.info(`\nInterrupted. Aborting...`);
      controller.abort();
    });

    // Run engine with fully resolved inputs
    const knox = new Knox({
      task: flags.task as string,
      dir,
      image,
      envVars: resolvedEnvVars,
      allowedIPs,
      model: flags.model as string,
      maxLoops,
      customPrompt,
      check: flags.check as string | undefined,
      cpuLimit: flags.cpu as string | undefined,
      memoryLimit: flags.memory as string | undefined,
      onLine: (line) => console.log(line),
      signal: controller.signal,
      runtime,
    });

    const outcome = await knox.run();

    if (outcome.ok) {
      log.always(formatSummary(outcome.result));

      // Create PR if output strategy is "pr"
      if (
        outputStrategy === "pr" &&
        outcome.result.sink.strategy === "host-git" &&
        outcome.result.sink.branchName
      ) {
        await createSinglePR(
          outcome.result.sink.branchName,
          flags.task as string,
          { draft: config.pr?.draft, base: config.pr?.base },
        );
      }

      if (outcome.result.aborted) {
        Deno.exit(130);
      }
      if (!outcome.result.completed) {
        Deno.exit(1);
      }
    } else {
      log.error(`Failed in ${outcome.phase} phase: ${outcome.error}`);
      Deno.exit(3);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(`Fatal: ${msg}`);
    if (msg.includes("Preflight checks failed")) {
      Deno.exit(2);
    }
    Deno.exit(3);
  }
} else {
  console.error(`Unknown command: ${effectiveCommand}`);
  console.error("");
  console.error(USAGE);
  Deno.exit(2);
}
