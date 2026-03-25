import { parse as parseYaml } from "@std/yaml";
import { join } from "@std/path";

export interface KnoxProjectConfig {
  output?: "pr" | "branch";
  pr?: {
    draft?: boolean;
    labels?: string[];
    reviewers?: string[];
  };
}

export interface ResolvedConfig {
  output: "pr" | "branch";
  pr: { draft: boolean; labels: string[]; reviewers: string[] };
}

interface ResolveOptions {
  dir: string;
  cliOutput?: string;
  command: "run" | "queue";
}

async function readProjectConfig(
  dir: string,
): Promise<KnoxProjectConfig | null> {
  const configPath = join(dir, ".knox", "config.yaml");
  try {
    const text = await Deno.readTextFile(configPath);
    const raw = parseYaml(text) as KnoxProjectConfig;
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
  const { dir, cliOutput, command } = options;

  const fileConfig = await readProjectConfig(dir);

  let output: "pr" | "branch";

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

  return {
    output,
    pr: {
      draft: fileConfig?.pr?.draft ?? false,
      labels: fileConfig?.pr?.labels ?? [],
      reviewers: fileConfig?.pr?.reviewers ?? [],
    },
  };
}
