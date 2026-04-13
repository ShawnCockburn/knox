import type { Difficulty } from "../difficulty/mod.ts";
import type {
  AgentProvider,
  ContainerHandle,
  LlmAgentContext,
} from "../engine/agent/agent_provider.ts";
import type { ProviderId } from "./provider_id.ts";
import type { ProviderSpec } from "./provider_spec.ts";

export interface ResolvedExecutionContext {
  readonly provider: ProviderId;
  readonly envVars: string[];
  readonly allowedIPs: string[];
  resolveModel(difficulty: Difficulty): string;
  prepareAgentProvider(
    container: ContainerHandle,
    model: string,
  ): Promise<AgentProvider<LlmAgentContext>>;
}

export class DefaultResolvedExecutionContext<TAuth>
  implements ResolvedExecutionContext {
  readonly provider: ProviderId;
  readonly envVars: string[];
  readonly allowedIPs: string[];

  constructor(
    private readonly spec: ProviderSpec<TAuth>,
    private readonly auth: TAuth,
    allowedIPs: string[],
  ) {
    this.provider = spec.id;
    this.envVars = spec.buildSessionEnvVars(auth);
    this.allowedIPs = allowedIPs;
  }

  resolveModel(difficulty: Difficulty): string {
    return this.spec.difficultyMap[difficulty];
  }

  prepareAgentProvider(
    container: ContainerHandle,
    model: string,
  ): Promise<AgentProvider<LlmAgentContext>> {
    return this.spec.prepareAgentProvider({
      container,
      auth: this.auth,
      model,
    });
  }
}
