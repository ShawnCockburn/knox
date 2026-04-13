import { codexDifficultyMap } from "../difficulty/mod.ts";
import { CodexAgentProvider } from "../engine/agent/codex_agent_provider.ts";
import type { ContainerHandle } from "../engine/agent/agent_provider.ts";
import { generateRunId } from "../shared/types.ts";
import { resolveCodexHostAuth } from "./codex_auth.ts";
import type { CodexHostAuth } from "./codex_auth.ts";
import type { ProviderSpec } from "./provider_spec.ts";

const CODEX_BIN = "/opt/codex/bin/codex";

const CODEX_REQUIRED_HOSTS = [
  "api.openai.com",
  "auth.openai.com",
] as const;

export class CodexProviderSpec implements ProviderSpec<CodexHostAuth> {
  readonly id = "codex" as const;
  readonly difficultyMap = codexDifficultyMap;

  resolveHostAuth(): Promise<CodexHostAuth> {
    return resolveCodexHostAuth();
  }

  buildSessionEnvVars(): string[] {
    return [];
  }

  requiredHosts(): readonly string[] {
    return CODEX_REQUIRED_HOSTS;
  }

  async prepareAgentProvider(
    { container, auth, model }: {
      container: ContainerHandle;
      auth: CodexHostAuth;
      model: string;
    },
  ) {
    await ensureBinary(container);

    const codexHome = `/tmp/knox-codex-${generateRunId()}`;
    await container.exec(["mkdir", "-p", codexHome], { user: "root" });
    await container.copyIn(auth.authFilePath, `${codexHome}/auth.json`);
    await container.exec(["chown", "-R", "knox:knox", codexHome], {
      user: "root",
    });
    await container.exec(["chmod", "700", codexHome], { user: "root" });
    await container.exec(["chmod", "600", `${codexHome}/auth.json`], {
      user: "root",
    });

    const authCheck = await container.exec(
      [CODEX_BIN, "exec", "--help"],
      {
        env: [
          `CODEX_HOME=${codexHome}`,
          "HOME=/tmp/knox-home",
        ],
      },
    );
    if (authCheck.exitCode !== 0) {
      throw new Error(
        `Selected provider 'codex' failed its runtime self-check: ${
          authCheck.stderr || authCheck.stdout || `exit ${authCheck.exitCode}`
        }`,
      );
    }

    return new CodexAgentProvider(model, { codexHome });
  }
}

async function ensureBinary(container: ContainerHandle): Promise<void> {
  const versionCheck = await container.exec([CODEX_BIN, "--version"]);
  if (versionCheck.exitCode !== 0) {
    throw new Error(
      `Selected provider 'codex' requires ${CODEX_BIN} in the image, but the runtime self-check failed: ${
        versionCheck.stderr || versionCheck.stdout ||
        `exit ${versionCheck.exitCode}`
      }`,
    );
  }
}
