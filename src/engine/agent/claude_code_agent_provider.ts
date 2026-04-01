import type {
  AgentProvider,
  InvokeResult,
  LlmAgentContext,
} from "./agent_provider.ts";
import { PromptBuilder } from "../prompt/prompt_builder.ts";
import { log } from "../../shared/log.ts";

/** Path to the Claude Code binary inside the agent container. */
const CLAUDE_BIN = "/opt/claude/bin/claude";

/** Sentinel string the agent outputs to signal task completion. */
const SENTINEL = "KNOX_COMPLETE";

/** Container path where the per-loop prompt file is written. */
const PROMPT_PATH = "/workspace/.knox/prompt.txt";

/** Container-relative path of the progress file agents read/write. */
const PROGRESS_FILE = "knox-progress.txt";

/**
 * AgentProvider implementation for Claude Code.
 *
 * Owns prompt building (via PromptBuilder), sentinel detection,
 * progress/git-log reading, and Claude CLI invocation.
 */
export class ClaudeCodeAgentProvider implements AgentProvider<LlmAgentContext> {
  private readonly model: string;
  private readonly promptBuilder: PromptBuilder;

  constructor(model: string) {
    this.model = model;
    this.promptBuilder = new PromptBuilder();
  }

  async invoke(ctx: LlmAgentContext): Promise<InvokeResult> {
    const { container, loopNumber } = ctx;

    // Gather context
    log.debug(
      `[claude-provider] Loop ${loopNumber}: reading progress file...`,
    );
    const progressFileContent = await this.readProgressFile(ctx);
    log.debug(
      `[claude-provider] Loop ${loopNumber}: progress file ${
        progressFileContent
          ? `found (${progressFileContent.length} bytes)`
          : "not found"
      }`,
    );

    log.debug(`[claude-provider] Loop ${loopNumber}: reading git log...`);
    const gitLog = await this.readGitLog(ctx);
    log.debug(
      `[claude-provider] Loop ${loopNumber}: git log ${
        gitLog ? `found (${gitLog.length} bytes)` : "empty"
      }`,
    );

    // Build prompt
    log.debug(`[claude-provider] Loop ${loopNumber}: building prompt...`);
    const prompt = this.promptBuilder.build({
      task: ctx.task,
      loopNumber: ctx.loopNumber,
      maxLoops: ctx.maxLoops,
      progressFileContent,
      gitLog,
      checkFailure: ctx.checkFailure,
      customPrompt: ctx.customPrompt,
    });
    log.debug(
      `[claude-provider] Loop ${loopNumber}: prompt built (${prompt.length} bytes)`,
    );

    // Write prompt to container
    log.debug(
      `[claude-provider] Loop ${loopNumber}: writing prompt to container...`,
    );
    await container.exec(
      ["mkdir", "-p", "/workspace/.knox"],
      { user: "root" },
    );
    await this.writePromptToContainer(ctx, PROMPT_PATH, prompt);
    await container.exec(
      ["chown", "-R", "knox:knox", "/workspace/.knox"],
      { user: "root" },
    );
    log.debug(
      `[claude-provider] Loop ${loopNumber}: prompt written to ${PROMPT_PATH}`,
    );

    // Run Claude
    let completed = false;
    const stderrLines: string[] = [];
    const claudeCmd =
      `${CLAUDE_BIN} -p --dangerously-skip-permissions --model ${this.model} < ${PROMPT_PATH}`;
    ctx.onLine?.(`[knox] Loop ${loopNumber}: invoking claude (model=${this.model})`);
    log.debug(
      `[claude-provider] Loop ${loopNumber}: executing claude: ${claudeCmd}`,
    );
    const exitCode = await container.execStream(
      ["sh", "-c", claudeCmd],
      {
        signal: ctx.signal,
        onLine: (line, stream) => {
          if (stream === "stdout") {
            if (line.includes(SENTINEL)) {
              completed = true;
            }
            ctx.onLine?.(line);
          } else {
            stderrLines.push(line);
            ctx.onLine?.(`[stderr] ${line}`);
          }
        },
      },
    );

    ctx.onLine?.(`[knox] Loop ${loopNumber}: claude exited (code=${exitCode}, completed=${completed})`);
    log.debug(
      `[claude-provider] Loop ${loopNumber}: claude exited with code ${exitCode}, completed=${completed}`,
    );
    if (exitCode !== 0) {
      log.debug(
        `[claude-provider] Loop ${loopNumber}: stderr line count: ${stderrLines.length}`,
      );
      if (stderrLines.length > 0) {
        log.debug(
          `[claude-provider] Loop ${loopNumber}: stderr (last 30 lines):\n${
            stderrLines.slice(-30).join("\n")
          }`,
        );
      }
    }

    return { completed, exitCode };
  }

  private async readProgressFile(
    ctx: LlmAgentContext,
  ): Promise<string | undefined> {
    const result = await ctx.container.exec(["cat", PROGRESS_FILE]);
    if (result.exitCode !== 0) return undefined;
    return result.stdout || undefined;
  }

  private async readGitLog(ctx: LlmAgentContext): Promise<string | undefined> {
    const result = await ctx.container.exec(["git", "log", "--oneline"]);
    if (result.exitCode !== 0) return undefined;
    return result.stdout || undefined;
  }

  private async writePromptToContainer(
    ctx: LlmAgentContext,
    containerPath: string,
    content: string,
  ): Promise<void> {
    const tmpFile = await Deno.makeTempFile({ suffix: ".txt" });
    try {
      await Deno.writeTextFile(tmpFile, content);
      log.debug(
        `[claude-provider] Copying prompt from ${tmpFile} → ${containerPath}`,
      );
      await ctx.container.copyIn(tmpFile, containerPath);
    } finally {
      await Deno.remove(tmpFile).catch(() => {});
    }
  }
}
