import type { ContainerSession } from "../session/container_session.ts";
import { PromptBuilder } from "../prompt/prompt_builder.ts";
import { log } from "../../shared/log.ts";
import type { KnoxEvent } from "../../shared/types.ts";

const SENTINEL = "KNOX_COMPLETE";
const PROMPT_PATH = "/workspace/.knox/prompt.txt";
const PROGRESS_FILE = "knox-progress.txt";
const MAX_RETRIES = 3;

const COMMIT_NUDGE_PROMPT =
  `You have uncommitted changes in the workspace. Review \`git diff\` and \`git status\`, then commit all changes with a meaningful conventional commit message (e.g., feat:, fix:, refactor:). Do NOT make any further code changes — only commit.`;

export interface AgentRunnerOptions {
  session: ContainerSession;
  model: string;
  task: string;
  maxLoops: number;
  checkCommand?: string;
  customPrompt?: string;
  onLine?: (line: string) => void;
  onEvent?: (event: KnoxEvent) => void;
  signal?: AbortSignal;
}

export interface AgentRunnerResult {
  completed: boolean;
  loopsRun: number;
  autoCommitted: boolean;
}

export class AgentRunner {
  private session: ContainerSession;
  private promptBuilder: PromptBuilder;
  private options: AgentRunnerOptions;

  constructor(options: AgentRunnerOptions) {
    this.options = options;
    this.session = options.session;
    this.promptBuilder = new PromptBuilder();
  }

  async run(): Promise<AgentRunnerResult> {
    let checkFailure: string | undefined;
    let completed = false;
    let loopsRun = this.options.maxLoops;

    for (let loop = 1; loop <= this.options.maxLoops; loop++) {
      // Check abort at loop boundary
      if (this.options.signal?.aborted) {
        loopsRun = loop - 1;
        break;
      }

      this.options.onEvent?.({
        type: "loop:start",
        loop,
        maxLoops: this.options.maxLoops,
      });

      log.info(`Starting loop: ${loop}`);
      const result = await this.runOneLoopWithRetry(loop, checkFailure);
      log.debug(
        `Loop: ${loop} executed with complete state: ${result.completed}`,
      );

      this.options.onEvent?.({
        type: "loop:end",
        loop,
        completed: result.completed,
      });

      checkFailure = undefined;

      if (result.completed) {
        // If there's a check command, verify
        if (this.options.checkCommand) {
          log.debug("Starting post loop check");
          const checkResult = await this.session.exec(
            ["sh", "-c", this.options.checkCommand],
          );

          if (checkResult.exitCode !== 0) {
            log.warn("Post loop check failed");
            checkFailure = checkResult.stdout + checkResult.stderr;
            this.options.onEvent?.({
              type: "check:failed",
              loop,
              output: checkFailure,
            });
            continue;
          }
          log.warn("Post loop check success");
        }

        completed = true;
        loopsRun = loop;
        break;
      }
    }

    // Commit nudge: handle uncommitted agent work
    const autoCommitted = await this.commitNudge();
    this.options.onEvent?.({ type: "nudge:result", committed: autoCommitted });

    return { completed, loopsRun, autoCommitted };
  }

  private async commitNudge(): Promise<boolean> {
    if (!(await this.session.hasDirtyTree())) {
      return false;
    }

    log.info(`Agent left uncommitted changes. Nudging to commit...`);
    try {
      await this.session.execStream(
        [
          "sh",
          "-c",
          `echo '${
            COMMIT_NUDGE_PROMPT.replace(/'/g, "'\\''")
          }' | claude -p --dangerously-skip-permissions --model ${this.options.model}`,
        ],
        {
          onLine: (line, stream) => {
            if (stream === "stdout") this.options.onLine?.(line);
          },
        },
      );
    } catch {
      // Nudge failed — fall through to mechanical auto-commit
    }

    // Check if still dirty after nudge
    if (await this.session.hasDirtyTree()) {
      log.info(`Nudge did not produce a commit. Auto-committing...`);
      await this.session.exec([
        "sh",
        "-c",
        `git add -A && git commit -m "knox: auto-commit uncommitted agent work"`,
      ]);
      return true;
    }

    return false;
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

    // Write prompt to container (mkdir and chown as root since docker cp creates root-owned files)
    await this.session.exec(
      ["mkdir", "-p", "/workspace/.knox"],
      { user: "root" },
    );
    await this.writePromptToContainer(PROMPT_PATH, prompt);
    await this.session.exec(
      ["chown", "-R", "knox:knox", "/workspace/.knox"],
      { user: "root" },
    );

    // Run claude
    let completed = false;
    const exitCode = await this.session.execStream(
      [
        "sh",
        "-c",
        `claude -p --dangerously-skip-permissions --model ${this.options.model} < ${PROMPT_PATH}`,
      ],
      {
        onLine: (line, stream) => {
          if (stream === "stdout") {
            if (line.includes(SENTINEL)) {
              completed = true;
            }
            this.options.onLine?.(line);
          } else {
            this.options.onLine?.(`[stderr] ${line}`);
          }
        },
      },
    );

    return { completed, exitCode };
  }

  private async readProgressFile(): Promise<string | undefined> {
    const result = await this.session.exec([
      "cat",
      PROGRESS_FILE,
    ]);
    if (result.exitCode !== 0) return undefined;
    return result.stdout || undefined;
  }

  private async readGitLog(): Promise<string | undefined> {
    const result = await this.session.exec(
      ["git", "log", "--oneline"],
    );
    if (result.exitCode !== 0) return undefined;
    return result.stdout || undefined;
  }

  private async writePromptToContainer(
    containerPath: string,
    content: string,
  ): Promise<void> {
    // Write to a temp file on host, then copy via session
    const tmpFile = await Deno.makeTempFile({ suffix: ".txt" });
    try {
      await Deno.writeTextFile(tmpFile, content);
      // Use the session's containerId for the low-level copyIn
      // This is a necessary coupling since copyIn is a runtime-level operation
      await this.session.copyIn(tmpFile, containerPath);
    } finally {
      await Deno.remove(tmpFile).catch(() => {});
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
