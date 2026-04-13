import type { Difficulty, DifficultyMap } from "../difficulty/mod.ts";
import { resolveDifficulty } from "../difficulty/mod.ts";
import type {
  AgentProvider,
  ContainerHandle,
  LlmAgentContext,
} from "../engine/agent/agent_provider.ts";
import type { ProviderId } from "./provider_id.ts";

export interface PrepareAgentProviderOptions<TAuth> {
  container: ContainerHandle;
  auth: TAuth;
  model: string;
}

export interface ProviderSpec<TAuth> {
  readonly id: ProviderId;
  readonly difficultyMap: DifficultyMap;
  resolveHostAuth(): Promise<TAuth>;
  buildSessionEnvVars(auth: TAuth): string[];
  requiredHosts(auth: TAuth): readonly string[];
  prepareAgentProvider(
    options: PrepareAgentProviderOptions<TAuth>,
  ): Promise<AgentProvider<LlmAgentContext>>;
}

export function createModelResolver(map: DifficultyMap) {
  return (difficulty: Difficulty): string => resolveDifficulty(difficulty, map);
}
