import { parse as parseYaml } from "@std/yaml";
import { join } from "@std/path";
import type { QueueDefaults } from "../../queue/types.ts";
import { isProviderId } from "../../provider/provider_id.ts";
import type { ProviderId } from "../../provider/provider_id.ts";

export interface KnoxProjectConfig {
  provider?: ProviderId;
  output?: "pr" | "branch";
  pr?: {
    draft?: boolean;
    base?: string;
    labels?: string[];
    reviewers?: string[];
  };
  github?: {
    authors?: string[];
    defaults?: QueueDefaults;
  };
}

export interface ResolvedConfig {
  provider?: ProviderId;
  output: "pr" | "branch";
  pr: {
    draft: boolean;
    base?: string;
    labels: string[];
    reviewers: string[];
  };
  github?: KnoxProjectConfig["github"];
}

interface ResolveOptions {
  dir: string;
  cliOutput?: string;
  cliProvider?: string;
  command: "run" | "queue";
}

async function readProjectConfig(
  dir: string,
): Promise<KnoxProjectConfig | null> {
  const configPath = join(dir, ".knox", "config.yaml");
  try {
    const text = await Deno.readTextFile(configPath);
    const raw = parseYaml(text) as KnoxProjectConfig;
    if (raw.provider !== undefined && !isProviderId(raw.provider)) {
      throw new Error(
        `Invalid provider value in .knox/config.yaml: "${raw.provider}". Must be one of: claude, codex.`,
      );
    }
    if (
      raw.output !== undefined &&
      raw.output !== "pr" &&
      raw.output !== "branch"
    ) {
      throw new Error(
        `Invalid output value in .knox/config.yaml: "${raw.output}". Must be "pr" or "branch".`,
      );
    }
    return raw;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

export async function resolveConfig(
  options: ResolveOptions,
): Promise<ResolvedConfig> {
  const { dir, cliOutput, cliProvider, command } = options;

  const fileConfig = await readProjectConfig(dir);

  let output: "pr" | "branch";
  let provider: ProviderId | undefined;

  if (cliOutput !== undefined) {
    if (cliOutput !== "pr" && cliOutput !== "branch") {
      throw new Error(
        `Invalid --output value: "${cliOutput}". Must be "pr" or "branch".`,
      );
    }
    output = cliOutput as "pr" | "branch";
  } else if (command === "run") {
    output = "branch";
  } else {
    output = fileConfig?.output ?? "branch";
  }

  if (cliProvider !== undefined) {
    if (!isProviderId(cliProvider)) {
      throw new Error(
        `Invalid --provider value: "${cliProvider}". Must be one of: claude, codex.`,
      );
    }
    provider = cliProvider;
  } else {
    provider = fileConfig?.provider;
  }

  return {
    provider,
    output,
    pr: {
      draft: fileConfig?.pr?.draft ?? false,
      base: fileConfig?.pr?.base,
      labels: fileConfig?.pr?.labels ?? [],
      reviewers: fileConfig?.pr?.reviewers ?? [],
    },
    github: fileConfig?.github,
  };
}
