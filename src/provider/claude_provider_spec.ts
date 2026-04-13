import { claudeCodeDifficultyMap } from "../difficulty/mod.ts";
import { ClaudeCodeAgentProvider } from "../engine/agent/claude_code_agent_provider.ts";
import { CLAUDE_REQUIRED_HOSTS } from "../shared/knox/resolve_network.ts";
import { resolveAuth } from "../shared/knox/resolve_auth.ts";
import type { ProviderSpec } from "./provider_spec.ts";

const CLAUDE_BIN = "/opt/claude/bin/claude";

interface ClaudeHostAuth {
  envVars: string[];
}

export class ClaudeProviderSpec implements ProviderSpec<ClaudeHostAuth> {
  readonly id = "claude" as const;
  readonly difficultyMap = claudeCodeDifficultyMap;

  async resolveHostAuth(): Promise<ClaudeHostAuth> {
    return {
      envVars: await resolveAuth([]),
    };
  }

  buildSessionEnvVars(auth: ClaudeHostAuth): string[] {
    return [...auth.envVars];
  }

  requiredHosts(): readonly string[] {
    return CLAUDE_REQUIRED_HOSTS;
  }

  async prepareAgentProvider({
    container,
    model,
  }: {
    container: import("../engine/agent/agent_provider.ts").ContainerHandle;
    auth: ClaudeHostAuth;
    model: string;
  }) {
    const versionCheck = await container.exec([CLAUDE_BIN, "--version"]);
    if (versionCheck.exitCode !== 0) {
      throw new Error(
        `Selected provider 'claude' requires ${CLAUDE_BIN} in the image, but the runtime self-check failed: ${
          versionCheck.stderr || versionCheck.stdout ||
          `exit ${versionCheck.exitCode}`
        }`,
      );
    }

    return new ClaudeCodeAgentProvider(model);
  }
}
