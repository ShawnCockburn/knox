import type {
  AgentProvider,
  InvokeResult,
  LlmAgentContext,
} from "./agent_provider.ts";
import { PromptBuilder } from "../prompt/prompt_builder.ts";
import { log } from "../../shared/log.ts";

const CODEX_BIN = "/opt/codex/bin/codex";
const SENTINEL = "KNOX_COMPLETE";
const PROMPT_PATH = "/workspace/.knox/prompt.txt";
const PROGRESS_FILE = "knox-progress.txt";

export interface CodexAgentProviderOptions {
  codexHome: string;
}

export class CodexAgentProvider implements AgentProvider<LlmAgentContext> {
  private readonly promptBuilder = new PromptBuilder();

  constructor(
    private readonly model: string,
    private readonly options: CodexAgentProviderOptions,
  ) {}

  async invoke(ctx: LlmAgentContext): Promise<InvokeResult> {
    const { container, loopNumber } = ctx;

    const progressFileContent = await this.readProgressFile(ctx);
    const gitLog = await this.readGitLog(ctx);
    const prompt = this.promptBuilder.build({
      task: ctx.task,
      loopNumber: ctx.loopNumber,
      maxLoops: ctx.maxLoops,
      progressFileContent,
      gitLog,
      checkFailure: ctx.checkFailure,
      customPrompt: ctx.customPrompt,
    });

    await container.exec(["mkdir", "-p", "/workspace/.knox"], { user: "root" });
    await this.writePromptToContainer(ctx, PROMPT_PATH, prompt);
    await container.exec(["chown", "-R", "knox:knox", "/workspace/.knox"], {
      user: "root",
    });

    let completed = false;
    const stderrLines: string[] = [];
    const codexCmd =
      `${CODEX_BIN} --dangerously-bypass-approvals-and-sandbox exec --model ${this.model} --color never -C /workspace < ${PROMPT_PATH}`;

    ctx.onLine?.(
      `[knox] Loop ${loopNumber}: invoking codex (model=${this.model})`,
    );
    log.debug(
      `[codex-provider] Loop ${loopNumber}: executing codex: ${codexCmd}`,
    );

    const exitCode = await container.execStream(
      ["sh", "-c", codexCmd],
      {
        signal: ctx.signal,
        env: [
          `CODEX_HOME=${this.options.codexHome}`,
          "HOME=/tmp/knox-home",
        ],
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

    ctx.onLine?.(
      `[knox] Loop ${loopNumber}: codex exited (code=${exitCode}, completed=${completed})`,
    );
    if (exitCode !== 0 && stderrLines.length > 0) {
      log.debug(
        `[codex-provider] Loop ${loopNumber}: stderr (last 30 lines):\n${
          stderrLines.slice(-30).join("\n")
        }`,
      );
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
      await ctx.container.copyIn(tmpFile, containerPath);
    } finally {
      await Deno.remove(tmpFile).catch(() => {});
    }
  }
}
