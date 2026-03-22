import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { validateManifest } from "./validation.ts";
import type {
  ItemState,
  LoadResult,
  QueueSource,
  QueueState,
} from "./types.ts";

/**
 * Queue source backed by a YAML file on disk.
 *
 * The queue file is read-only input. State is persisted to a separate
 * `.state.yaml` file alongside the queue file.
 */
export class FileQueueSource implements QueueSource {
  private readonly statePath: string;

  constructor(private readonly filePath: string) {
    // foo.yaml → foo.state.yaml
    this.statePath = filePath.replace(/\.ya?ml$/, "") + ".state.yaml";
  }

  async load(): Promise<LoadResult> {
    const text = await Deno.readTextFile(this.filePath);
    const raw = parseYaml(text);
    const result = validateManifest(raw);

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
        // Will be initialized by the orchestrator before first update
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
