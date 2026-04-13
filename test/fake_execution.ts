import type {
  AgentProvider,
  ContainerHandle,
  LlmAgentContext,
} from "../src/engine/agent/agent_provider.ts";
import {
  claudeCodeDifficultyMap,
  codexDifficultyMap,
} from "../src/difficulty/mod.ts";
import type { Difficulty } from "../src/difficulty/mod.ts";
import {
  ClaudeCodeAgentProvider,
  CodexAgentProvider,
} from "../src/engine/mod.ts";
import type {
  ProviderId,
  ResolvedExecutionContext,
} from "../src/provider/mod.ts";

export function createFakeExecutionContext(
  options: {
    provider?: ProviderId;
    envVars?: string[];
    allowedIPs?: string[];
    resolveModel?: (difficulty: Difficulty) => string;
  } = {},
): ResolvedExecutionContext {
  return {
    provider: options.provider ?? "claude",
    envVars: options.envVars ?? [],
    allowedIPs: options.allowedIPs ?? [],
    resolveModel(difficulty: Difficulty): string {
      if (options.resolveModel) return options.resolveModel(difficulty);
      return options.provider === "codex"
        ? codexDifficultyMap[difficulty]
        : claudeCodeDifficultyMap[difficulty];
    },
    prepareAgentProvider(
      _container: ContainerHandle,
      model: string,
    ): Promise<AgentProvider<LlmAgentContext>> {
      return Promise.resolve(
        options.provider === "codex"
          ? new CodexAgentProvider(model, { codexHome: "/tmp/test-codex-home" })
          : new ClaudeCodeAgentProvider(model),
      );
    },
  };
}
