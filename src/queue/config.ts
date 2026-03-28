import { parse as parseYaml } from "@std/yaml";
import { join } from "@std/path";
import type { QueueDefaults } from "./types.ts";

/** Knox project configuration loaded from .knox/config.yaml. */
export interface KnoxConfig {
  /** Output strategy: "branch" (default) or "pr". */
  output?: "branch" | "pr";
  /** Pull-request creation options (used when output = "pr"). */
  pr?: {
    draft?: boolean;
    base?: string;
  };
  /** GitHub Issues queue source configuration. */
  github?: {
    /** GitHub usernames whose issues are ingested. Defaults to current gh user. */
    authors?: string[];
    /** Queue-level defaults applied to issues missing these fields. */
    defaults?: QueueDefaults;
  };
}

/**
 * Load .knox/config.yaml from the project directory.
 * Returns an empty config object if the file does not exist.
 */
export async function resolveConfig(projectDir: string): Promise<KnoxConfig> {
  const configPath = join(projectDir, ".knox", "config.yaml");
  try {
    const text = await Deno.readTextFile(configPath);
    const raw = parseYaml(text);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as KnoxConfig;
    }
    return {};
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return {};
    throw e;
  }
}
