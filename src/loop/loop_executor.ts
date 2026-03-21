import type { ContainerRuntime } from "../runtime/container_runtime.ts";
import type { ContainerId } from "../types.ts";
import { PromptBuilder } from "../prompt/prompt_builder.ts";

const SENTINEL = "KNOX_COMPLETE";
const WORKSPACE = "/workspace";
const PROMPT_PATH = "/workspace/.knox/prompt.txt";
const PROGRESS_FILE = "knox-progress.txt";
const MAX_RETRIES = 3;

export interface LoopExecutorOptions {
  runtime: ContainerRuntime;
  containerId: ContainerId;
  model: string;
  task: string;
  maxLoops: number;
  checkCommand?: string;
  customPrompt?: string;
  onLine?: (line: string) => void;
}

export interface LoopResult {
  completed: boolean;
  loopsRun: number;
}

export class LoopExecutor {
  private runtime: ContainerRuntime;
  private promptBuilder: PromptBuilder;
  private options: LoopExecutorOptions;

  constructor(options: LoopExecutorOptions) {
    this.options = options;
    this.runtime = options.runtime;
    this.promptBuilder = new PromptBuilder();
  }

  async run(): Promise<LoopResult> {
    let checkFailure: string | undefined;

    for (let loop = 1; loop <= this.options.maxLoops; loop++) {
      const result = await this.runOneLoopWithRetry(loop, checkFailure);
      checkFailure = undefined;

      if (result.completed) {
        // If there's a check command, verify
        if (this.options.checkCommand) {
          const checkResult = await this.runtime.exec(
            this.options.containerId,
            ["sh", "-c", this.options.checkCommand],
            { workdir: WORKSPACE },
          );

          if (checkResult.exitCode !== 0) {
            // Check failed — continue looping with failure context
            checkFailure = checkResult.stdout + checkResult.stderr;
            continue;
          }
        }

        return { completed: true, loopsRun: loop };
      }
    }

    return { completed: false, loopsRun: this.options.maxLoops };
  }

  private async runOneLoopWithRetry(
    loopNumber: number,
    checkFailure?: string,
  ): Promise<{ completed: boolean }> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await this.runOneLoop(loopNumber, checkFailure);

        if (result.exitCode !== 0 && attempt < MAX_RETRIES) {
          await delay(1000 * Math.pow(2, attempt));
          continue;
        }

        return { completed: result.completed };
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < MAX_RETRIES) {
          await delay(1000 * Math.pow(2, attempt));
          continue;
        }
      }
    }

    throw lastError ?? new Error("Loop execution failed after retries");
  }

  private async runOneLoop(
    loopNumber: number,
    checkFailure?: string,
  ): Promise<{ completed: boolean; exitCode: number }> {
    // Gather context
    const progressFileContent = await this.readProgressFile();
    const gitLog = await this.readGitLog();

    // Build prompt
    const prompt = this.promptBuilder.build({
      task: this.options.task,
      loopNumber,
      maxLoops: this.options.maxLoops,
      progressFileContent,
      gitLog,
      checkFailure,
      customPrompt: this.options.customPrompt,
    });

    // Write prompt to container
    await this.runtime.exec(this.options.containerId, [
      "mkdir",
      "-p",
      "/workspace/.knox",
    ]);
    await this.writePromptToContainer(PROMPT_PATH, prompt);

    // Run claude
    let completed = false;
    const exitCode = await this.runtime.execStream(
      this.options.containerId,
      [
        "sh",
        "-c",
        `claude -p --dangerously-skip-permissions --model ${this.options.model} < ${PROMPT_PATH}`,
      ],
      {
        workdir: WORKSPACE,
        onLine: (line, stream) => {
          if (stream === "stdout") {
            if (line.includes(SENTINEL)) {
              completed = true;
            }
            this.options.onLine?.(line);
          }
        },
      },
    );

    return { completed, exitCode };
  }

  private async readProgressFile(): Promise<string | undefined> {
    const result = await this.runtime.exec(this.options.containerId, [
      "cat",
      `${WORKSPACE}/${PROGRESS_FILE}`,
    ]);
    if (result.exitCode !== 0) return undefined;
    return result.stdout || undefined;
  }

  private async readGitLog(): Promise<string | undefined> {
    const result = await this.runtime.exec(
      this.options.containerId,
      ["git", "log", "--oneline"],
      { workdir: WORKSPACE },
    );
    if (result.exitCode !== 0) return undefined;
    return result.stdout || undefined;
  }

  private async writePromptToContainer(
    containerPath: string,
    content: string,
  ): Promise<void> {
    // Write to a temp file on host, then copyIn
    const tmpFile = await Deno.makeTempFile({ suffix: ".txt" });
    try {
      await Deno.writeTextFile(tmpFile, content);
      await this.runtime.copyIn(
        this.options.containerId,
        tmpFile,
        containerPath,
      );
    } finally {
      await Deno.remove(tmpFile).catch(() => {});
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
