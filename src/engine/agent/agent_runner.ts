import type { ContainerSession } from "../session/container_session.ts";
import { PromptBuilder } from "../prompt/prompt_builder.ts";
import { log } from "../../shared/log.ts";
import type { KnoxEvent } from "../../shared/types.ts";

const SENTINEL = "KNOX_COMPLETE";
const PROMPT_PATH = "/workspace/.knox/prompt.txt";
const PROGRESS_FILE = "knox-progress.txt";
const MAX_RETRIES = 3;
const CLAUDE_BIN = "/opt/claude/bin/claude";

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

    log.debug(`[agent] Starting agent run: model=${this.options.model} maxLoops=${this.options.maxLoops}`);
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
          log.debug(`[agent] Running post-loop check: ${this.options.checkCommand}`);
          const checkResult = await this.session.exec(
            ["sh", "-c", this.options.checkCommand],
          );

          if (checkResult.exitCode !== 0) {
            log.warn("Post loop check failed");
            log.debug(`[agent] Check stdout: ${checkResult.stdout.slice(0, 500)}`);
            log.debug(`[agent] Check stderr: ${checkResult.stderr.slice(0, 500)}`);
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

    log.debug(`[agent] Agent run complete: completed=${completed} loopsRun=${loopsRun}`);
    return { completed, loopsRun, autoCommitted };
  }

  private async commitNudge(): Promise<boolean> {
    if (!(await this.session.hasDirtyTree())) {
      log.debug(`[agent] No dirty tree, skipping nudge`);
      return false;
    }

    log.info(`Agent left uncommitted changes. Nudging to commit...`);
    try {
      const nudgeCmd = `echo '${
        COMMIT_NUDGE_PROMPT.replace(/'/g, "'\\''")
      }' | ${CLAUDE_BIN} -p --dangerously-skip-permissions --model ${this.options.model}`;
      log.debug(`[agent] Nudge command: ${nudgeCmd}`);
      const exitCode = await this.session.execStream(
        ["sh", "-c", nudgeCmd],
        {
          onLine: (line, stream) => {
            if (stream === "stdout") this.options.onLine?.(line);
            else log.debug(`[agent:nudge:stderr] ${line}`);
          },
        },
      );
      log.debug(`[agent] Nudge exit code: ${exitCode}`);
    } catch (e) {
      log.debug(`[agent] Nudge failed: ${e instanceof Error ? e.message : e}`);
      // Nudge failed — fall through to mechanical auto-commit
    }

    // Check if still dirty after nudge
    if (await this.session.hasDirtyTree()) {
      log.info(`Nudge did not produce a commit. Auto-committing...`);
      const commitResult = await this.session.exec([
        "sh",
        "-c",
        `git add -A && git commit -m "knox: auto-commit uncommitted agent work"`,
      ]);
      log.debug(`[agent] Auto-commit exit=${commitResult.exitCode} stdout=${commitResult.stdout.trimEnd()}`);
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
          log.debug(`[agent] Loop ${loopNumber} retry attempt ${attempt}/${MAX_RETRIES}`);
        }
        const result = await this.runOneLoop(loopNumber, checkFailure);

        if (result.exitCode !== 0 && attempt < MAX_RETRIES) {
          log.debug(`[agent] Loop ${loopNumber} exited with ${result.exitCode}, retrying after ${1000 * Math.pow(2, attempt)}ms...`);
          await delay(1000 * Math.pow(2, attempt));
          continue;
        }

        if (result.exitCode !== 0) {
          log.debug(`[agent] Loop ${loopNumber} exited with ${result.exitCode} after all retries`);
        }

        return { completed: result.completed };
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        log.debug(`[agent] Loop ${loopNumber} threw: ${lastError.message}`);
        if (attempt < MAX_RETRIES) {
          log.debug(`[agent] Retrying after ${1000 * Math.pow(2, attempt)}ms...`);
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
    log.debug(`[agent] Loop ${loopNumber}: reading progress file...`);
    const progressFileContent = await this.readProgressFile();
    log.debug(`[agent] Loop ${loopNumber}: progress file ${progressFileContent ? `found (${progressFileContent.length} bytes)` : "not found"}`);

    log.debug(`[agent] Loop ${loopNumber}: reading git log...`);
    const gitLog = await this.readGitLog();
    log.debug(`[agent] Loop ${loopNumber}: git log ${gitLog ? `found (${gitLog.length} bytes)` : "empty"}`);

    // Build prompt
    log.debug(`[agent] Loop ${loopNumber}: building prompt...`);
    const prompt = this.promptBuilder.build({
      task: this.options.task,
      loopNumber,
      maxLoops: this.options.maxLoops,
      progressFileContent,
      gitLog,
      checkFailure,
      customPrompt: this.options.customPrompt,
    });
    log.debug(`[agent] Loop ${loopNumber}: prompt built (${prompt.length} bytes)`);

    // Write prompt to container (mkdir and chown as root since docker cp creates root-owned files)
    log.debug(`[agent] Loop ${loopNumber}: writing prompt to container...`);
    await this.session.exec(
      ["mkdir", "-p", "/workspace/.knox"],
      { user: "root" },
    );
    await this.writePromptToContainer(PROMPT_PATH, prompt);
    await this.session.exec(
      ["chown", "-R", "knox:knox", "/workspace/.knox"],
      { user: "root" },
    );
    log.debug(`[agent] Loop ${loopNumber}: prompt written to ${PROMPT_PATH}`);

    // Run claude
    let completed = false;
    const stderrLines: string[] = [];
    const claudeCmd =
      `${CLAUDE_BIN} -p --dangerously-skip-permissions --model ${this.options.model} < ${PROMPT_PATH}`;
    log.debug(`[agent] Loop ${loopNumber}: executing claude: ${claudeCmd}`);
    const exitCode = await this.session.execStream(
      ["sh", "-c", claudeCmd],
      {
        onLine: (line, stream) => {
          if (stream === "stdout") {
            if (line.includes(SENTINEL)) {
              completed = true;
            }
            this.options.onLine?.(line);
          } else {
            stderrLines.push(line);
            this.options.onLine?.(`[stderr] ${line}`);
          }
        },
      },
    );

    log.debug(`[agent] Loop ${loopNumber}: claude exited with code ${exitCode}, completed=${completed}`);
    if (exitCode !== 0) {
      log.debug(`[agent] Loop ${loopNumber}: stderr line count: ${stderrLines.length}`);
      if (stderrLines.length > 0) {
        log.debug(
          `[agent] Loop ${loopNumber}: stderr (last 30 lines):\n${stderrLines.slice(-30).join("\n")}`,
        );
      }
    }

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
      log.debug(`[agent] Copying prompt from ${tmpFile} → ${containerPath}`);
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
