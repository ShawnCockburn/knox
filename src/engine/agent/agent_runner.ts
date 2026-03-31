import type {
  AgentProvider,
  ContainerHandle,
  LlmAgentContext,
} from "./agent_provider.ts";
import { log } from "../../shared/log.ts";
import type { KnoxEvent } from "../../shared/types.ts";

const MAX_RETRIES = 3;

const COMMIT_NUDGE_TASK =
  `You have uncommitted changes in the workspace. Review \`git diff\` and \`git status\`, then commit all changes with a meaningful conventional commit message (e.g., feat:, fix:, refactor:). Do NOT make any further code changes — only commit.`;

export interface AgentRunnerOptions {
  provider: AgentProvider<LlmAgentContext>;
  container: ContainerHandle;
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
  private provider: AgentProvider<LlmAgentContext>;
  private container: ContainerHandle;
  private options: AgentRunnerOptions;

  constructor(options: AgentRunnerOptions) {
    this.options = options;
    this.provider = options.provider;
    this.container = options.container;
  }

  async run(): Promise<AgentRunnerResult> {
    let checkFailure: string | undefined;
    let completed = false;
    let loopsRun = this.options.maxLoops;

    log.debug(
      `[agent] Starting agent run: maxLoops=${this.options.maxLoops}`,
    );
    log.debug(`[agent] Task: ${this.options.task.slice(0, 200)}...`);

    for (let loop = 1; loop <= this.options.maxLoops; loop++) {
      // Check abort at loop boundary
      if (this.options.signal?.aborted) {
        log.debug(`[agent] Aborted before loop ${loop}`);
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
        `[agent] Loop ${loop} result: completed=${result.completed}`,
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
          log.debug(
            `[agent] Running post-loop check: ${this.options.checkCommand}`,
          );
          const checkResult = await this.container.exec(
            ["sh", "-c", this.options.checkCommand],
          );

          if (checkResult.exitCode !== 0) {
            log.warn("Post loop check failed");
            log.debug(
              `[agent] Check stdout: ${checkResult.stdout.slice(0, 500)}`,
            );
            log.debug(
              `[agent] Check stderr: ${checkResult.stderr.slice(0, 500)}`,
            );
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
    log.debug(`[agent] Checking for uncommitted changes...`);
    const autoCommitted = await this.commitNudge();
    log.debug(`[agent] Commit nudge result: autoCommitted=${autoCommitted}`);
    this.options.onEvent?.({ type: "nudge:result", committed: autoCommitted });

    log.debug(
      `[agent] Agent run complete: completed=${completed} loopsRun=${loopsRun}`,
    );
    return { completed, loopsRun, autoCommitted };
  }

  private async hasDirtyTree(): Promise<boolean> {
    const result = await this.container.exec([
      "git",
      "status",
      "--porcelain",
    ]);
    return result.stdout.trim().length > 0;
  }

  private async commitNudge(): Promise<boolean> {
    if (!(await this.hasDirtyTree())) {
      log.debug(`[agent] No dirty tree, skipping nudge`);
      return false;
    }

    log.info(`Agent left uncommitted changes. Nudging to commit...`);
    try {
      await this.provider.invoke({
        container: this.container,
        task: COMMIT_NUDGE_TASK,
        loopNumber: 0,
        maxLoops: 0,
        onLine: this.options.onLine,
      });
    } catch (e) {
      log.debug(`[agent] Nudge failed: ${e instanceof Error ? e.message : e}`);
      // Nudge failed — fall through to mechanical auto-commit
    }

    // Check if still dirty after nudge
    if (await this.hasDirtyTree()) {
      log.info(`Nudge did not produce a commit. Auto-committing...`);
      const commitResult = await this.container.exec([
        "sh",
        "-c",
        `git add -A && git commit -m "knox: auto-commit uncommitted agent work"`,
      ]);
      log.debug(
        `[agent] Auto-commit exit=${commitResult.exitCode} stdout=${commitResult.stdout.trimEnd()}`,
      );
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
        if (attempt > 0) {
          log.debug(
            `[agent] Loop ${loopNumber} retry attempt ${attempt}/${MAX_RETRIES}`,
          );
        }
        const result = await this.provider.invoke({
          container: this.container,
          task: this.options.task,
          loopNumber,
          maxLoops: this.options.maxLoops,
          checkFailure,
          customPrompt: this.options.customPrompt,
          onLine: this.options.onLine,
        });

        if (result.exitCode !== 0 && attempt < MAX_RETRIES) {
          log.debug(
            `[agent] Loop ${loopNumber} exited with ${result.exitCode}, retrying after ${
              1000 * Math.pow(2, attempt)
            }ms...`,
          );
          await delay(1000 * Math.pow(2, attempt));
          continue;
        }

        if (result.exitCode !== 0) {
          log.debug(
            `[agent] Loop ${loopNumber} exited with ${result.exitCode} after all retries`,
          );
        }

        return { completed: result.completed };
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        log.debug(`[agent] Loop ${loopNumber} threw: ${lastError.message}`);
        if (attempt < MAX_RETRIES) {
          log.debug(
            `[agent] Retrying after ${1000 * Math.pow(2, attempt)}ms...`,
          );
          await delay(1000 * Math.pow(2, attempt));
          continue;
        }
      }
    }

    throw lastError ?? new Error("Loop execution failed after retries");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
