/** Unique identifier for a container image. */
export type ImageId = string;

/** Unique identifier for a running/stopped container. */
export type ContainerId = string;

/** Result of executing a command inside a container. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Options for creating a container. */
export interface CreateContainerOptions {
  image: ImageId;
  /** Container name (auto-generated if omitted). */
  name?: string;
  /** Working directory inside the container. */
  workdir?: string;
  /** Environment variables as KEY=VALUE strings. */
  env?: string[];
  /** Whether network is enabled (default: true). */
  networkEnabled?: boolean;
  /** Additional Linux capabilities (e.g., "NET_ADMIN"). */
  capAdd?: string[];
  /** CPU limit (e.g., "2" for 2 cores). */
  cpuLimit?: string;
  /** Memory limit (e.g., "4g" for 4 GB). */
  memoryLimit?: string;
  /** Command to keep container alive (default: ["sleep", "infinity"]). */
  entrypoint?: string[];
}

/** Options for building an image. */
export interface BuildImageOptions {
  /** Path to build context directory. */
  context: string;
  /** Dockerfile path within context (default: "Dockerfile"). */
  dockerfile?: string;
  /** Image tag. */
  tag: string;
  /** Build arguments. */
  buildArgs?: Record<string, string>;
}

/** Options for committing a container as an image. */
export interface CommitOptions {
  container: ContainerId;
  tag: string;
  message?: string;
}

/** Unique run identifier (8 hex characters). */
export type RunId = string;

/** Generate an 8-hex-character run ID from a UUID. */
export function generateRunId(): RunId {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

/** Phase where an expected engine failure occurred. */
export type FailurePhase = "container" | "agent" | "bundle" | "sink";

/** Structured lifecycle events emitted by the engine. */
export type KnoxEvent =
  | { type: "container:created"; containerId: string }
  | { type: "loop:start"; loop: number; maxLoops: number }
  | { type: "loop:end"; loop: number; completed: boolean }
  | { type: "check:failed"; loop: number; output: string }
  | { type: "nudge:result"; committed: boolean }
  | { type: "bundle:extracted"; path: string }
  | { type: "aborted" };

/** Generate a URL-safe slug from a task description. */
export function taskSlug(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}
