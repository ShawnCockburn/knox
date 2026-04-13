import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { parseMarkdownTask } from "./markdown_task_parser.ts";
import {
  collectExecutionLevelProviderWarnings,
  validateManifest,
} from "./validation.ts";
import { log } from "../shared/log.ts";
import type {
  ItemState,
  LoadResult,
  QueueDefaults,
  QueueSource,
  QueueState,
} from "./types.ts";

/**
 * Queue source backed by a directory of Markdown task files.
 *
 * Each `*.md` file (excluding `_`-prefixed files) is parsed as a QueueItem.
 * An optional `_defaults.yaml` file in the directory provides QueueDefaults.
 * State is persisted to `.state.yaml` inside the directory.
 */
export class DirectoryQueueSource implements QueueSource {
  private readonly dirPath: string;
  private readonly statePath: string;

  constructor(dirPath: string) {
    // Normalize: strip trailing slash for consistent path construction
    this.dirPath = dirPath.replace(/\/+$/, "");
    this.statePath = `${this.dirPath}/.state.yaml`;
  }

  async load(): Promise<LoadResult> {
    // Collect .md files in directory, sorted by filename for deterministic DAGs
    const mdFiles: string[] = [];

    try {
      for await (const entry of Deno.readDir(this.dirPath)) {
        if (
          entry.isFile &&
          entry.name.endsWith(".md") &&
          !entry.name.startsWith("_")
        ) {
          mdFiles.push(entry.name);
        }
      }
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        return {
          ok: false,
          errors: [{ message: `Directory not found: ${this.dirPath}` }],
        };
      }
      throw e;
    }

    if (mdFiles.length === 0) {
      return {
        ok: false,
        errors: [{
          message: `No .md files found in directory: ${this.dirPath}`,
        }],
      };
    }

    mdFiles.sort();

    // Parse each .md file
    const parseErrors: { file: string; message: string }[] = [];
    // deno-lint-ignore no-explicit-any
    const rawItems: any[] = [];

    for (const filename of mdFiles) {
      const filePath = `${this.dirPath}/${filename}`;
      const content = await Deno.readTextFile(filePath);
      const result = parseMarkdownTask(content, filename);

      if (result === null) {
        // Skipped (shouldn't happen since we already filter _-prefixed files)
        continue;
      }

      if (!result.ok) {
        for (const err of result.errors) {
          parseErrors.push({
            file: filename,
            message: err.message,
          });
        }
        continue;
      }

      for (const warning of result.warnings ?? []) {
        log.warn(`${filename}: ${warning.message}`);
      }

      rawItems.push(result.item);
    }

    if (parseErrors.length > 0) {
      return {
        ok: false,
        errors: parseErrors.map((e) => ({
          message: `${e.file}: ${e.message}`,
        })),
      };
    }

    // Read optional _defaults.yaml
    let defaults: QueueDefaults | undefined;
    const defaultsPath = `${this.dirPath}/_defaults.yaml`;
    try {
      const text = await Deno.readTextFile(defaultsPath);
      const parsed = parseYaml(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        defaults = parsed as QueueDefaults;
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        throw e;
      }
    }

    // Assemble raw manifest and validate
    const rawManifest = {
      items: rawItems,
      ...(defaults !== undefined && { defaults }),
    };
    for (const warning of collectExecutionLevelProviderWarnings(rawManifest)) {
      log.warn(warning.message);
    }

    const result = validateManifest(rawManifest);

    if (result.errors.length > 0) {
      return { ok: false, errors: result.errors };
    }

    return { ok: true, manifest: result.manifest! };
  }

  async update(itemId: string, state: Partial<ItemState>): Promise<void> {
    let queueState: QueueState;

    try {
      const text = await Deno.readTextFile(this.statePath);
      queueState = parseYaml(text) as QueueState;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        queueState = {
          queueRunId: "",
          startedAt: new Date().toISOString(),
          items: {},
        };
      } else {
        throw e;
      }
    }

    queueState.items[itemId] = {
      ...queueState.items[itemId],
      ...state,
    };

    await Deno.writeTextFile(
      this.statePath,
      stringifyYaml(queueState as unknown as Record<string, unknown>),
    );
  }

  /** Read the existing state file. Returns null if it doesn't exist. */
  async readState(): Promise<QueueState | null> {
    try {
      const text = await Deno.readTextFile(this.statePath);
      return parseYaml(text) as QueueState;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
  }

  /** Write the full state file (used for initialization and resume). */
  async writeState(state: QueueState): Promise<void> {
    await Deno.writeTextFile(
      this.statePath,
      stringifyYaml(state as unknown as Record<string, unknown>),
    );
  }

  /** Get the state file path. */
  getStatePath(): string {
    return this.statePath;
  }
}
