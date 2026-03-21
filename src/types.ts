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
  /** Working directory inside the container. */
  workdir?: string;
  /** Environment variables as KEY=VALUE strings. */
  env?: string[];
  /** Whether network is enabled (default: true). */
  networkEnabled?: boolean;
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
