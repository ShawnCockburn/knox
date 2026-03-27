import type { KnoxOutcome } from "../engine/knox.ts";

/** Status of a queue item throughout its lifecycle. */
export type ItemStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked";

/** Feature spec: bare string ("python") or name:version ("python:3.12") or object ({python: "3.12"}). */
export type FeatureConfigEntry = string | Record<string, string>;

/** Environment configuration for a queue item or defaults. */
export interface EnvironmentConfig {
  readonly features?: FeatureConfigEntry[];
  readonly prepare?: string;
  readonly image?: string;
}

/** A single item in the queue manifest. */
export interface QueueItem extends EnvironmentConfig {
  readonly id: string;
  readonly task: string;
  readonly group?: string;
  readonly dependsOn?: string[];
  readonly model?: string;
  readonly check?: string;
  readonly maxLoops?: number;
  readonly env?: string[];
  readonly prompt?: string;
  readonly cpu?: string;
  readonly memory?: string;
}

/** Queue-level defaults that merge with per-item overrides. */
export interface QueueDefaults extends EnvironmentConfig {
  readonly model?: string;
  readonly check?: string;
  readonly maxLoops?: number;
  readonly env?: string[];
  readonly prompt?: string;
  readonly cpu?: string;
  readonly memory?: string;
}

/** The full queue manifest loaded from a queue file. */
export interface QueueManifest {
  readonly items: QueueItem[];
  readonly defaults?: QueueDefaults;
  readonly concurrency?: number;
}

/** Per-item state persisted to the state file. */
export interface ItemState {
  status: ItemStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  branch?: string;
  outcome?: KnoxOutcome;
  blockedBy?: string;
}

/** Full state file structure. */
export interface QueueState {
  queueRunId: string;
  startedAt: string;
  finishedAt?: string;
  items: Record<string, ItemState>;
}

/** A single validation error. */
export interface ValidationError {
  readonly itemId?: string;
  readonly field?: string;
  readonly message: string;
}

/** Result of loading a queue — either success or collected errors. */
export type LoadResult =
  | { ok: true; manifest: QueueManifest }
  | { ok: false; errors: ValidationError[] };

/** Interface for queue data sources. */
export interface QueueSource {
  load(): Promise<LoadResult>;
  update(
    itemId: string,
    state: Partial<ItemState>,
  ): Promise<void>;
}
