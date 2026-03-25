import { join } from "@std/path";
import { FileQueueSource } from "./file_queue_source.ts";
import type { ItemState, LoadResult, QueueSource, QueueState } from "./types.ts";

/**
 * Queue source backed by a named directory (e.g., .knox/queues/<name>/).
 * Expects a queue.yaml file inside the directory.
 *
 * State is persisted alongside the queue.yaml as queue.state.yaml.
 */
export class DirectoryQueueSource implements QueueSource {
  private readonly inner: FileQueueSource;
  /** Absolute path to the queue.yaml file inside the directory. */
  readonly queueYamlPath: string;

  constructor(readonly dirPath: string) {
    this.queueYamlPath = join(dirPath, "queue.yaml");
    this.inner = new FileQueueSource(this.queueYamlPath);
  }

  load(): Promise<LoadResult> {
    return this.inner.load();
  }

  update(itemId: string, state: Partial<ItemState>): Promise<void> {
    return this.inner.update(itemId, state);
  }

  readState(): Promise<QueueState | null> {
    return this.inner.readState();
  }

  writeState(state: QueueState): Promise<void> {
    return this.inner.writeState(state);
  }
}

/**
 * Discover all queue directories under <projectDir>/.knox/queues/.
 * A valid queue directory must contain a queue.yaml file.
 * Returns sorted list of absolute directory paths.
 */
export async function discoverQueueDirs(projectDir: string): Promise<string[]> {
  const queuesDir = join(projectDir, ".knox", "queues");
  const dirs: string[] = [];

  try {
    for await (const entry of Deno.readDir(queuesDir)) {
      if (entry.isDirectory) {
        const queueYaml = join(queuesDir, entry.name, "queue.yaml");
        try {
          await Deno.stat(queueYaml);
          dirs.push(join(queuesDir, entry.name));
        } catch {
          // No queue.yaml in this directory — skip
        }
      }
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }

  return dirs.sort();
}
