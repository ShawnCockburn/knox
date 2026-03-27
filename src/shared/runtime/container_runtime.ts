import type {
  BuildImageOptions,
  CommitOptions,
  ContainerId,
  CreateContainerOptions,
  ExecResult,
  ImageId,
} from "../types.ts";

/** Options for exec and execStream calls. */
export interface ExecOptions {
  workdir?: string;
  env?: string[];
  /** User to run as (e.g., "root"). Defaults to the image's USER. */
  user?: string;
}

/** Callback for streaming exec output line by line. */
export type OnLineCallback = (
  line: string,
  stream: "stdout" | "stderr",
) => void;

/**
 * Abstract interface for container operations.
 * Implementations: DockerRuntime, (future) AppleContainerRuntime.
 */
export interface ContainerRuntime {
  /** Build an image from a Dockerfile/context. */
  buildImage(options: BuildImageOptions): Promise<ImageId>;

  /** Check if an image exists locally. */
  imageExists(tag: string): Promise<boolean>;

  /** Create and start a container from an image. */
  createContainer(options: CreateContainerOptions): Promise<ContainerId>;

  /** Execute a command inside a running container. */
  exec(
    container: ContainerId,
    command: string[],
    options?: ExecOptions,
  ): Promise<ExecResult>;

  /**
   * Execute a command and stream stdout/stderr line-by-line.
   * Returns exit code. Calls onLine for each line of output.
   */
  execStream(
    container: ContainerId,
    command: string[],
    options: ExecOptions & { onLine: OnLineCallback },
  ): Promise<number>;

  /** Copy a file or directory from host into the container. */
  copyIn(
    container: ContainerId,
    hostPath: string,
    containerPath: string,
  ): Promise<void>;

  /** Copy a file or directory from container to host. */
  copyOut(
    container: ContainerId,
    containerPath: string,
    hostPath: string,
  ): Promise<void>;

  /** Commit a container's filesystem as a new image. */
  commit(options: CommitOptions): Promise<ImageId>;

  /**
   * Restrict container egress to only the given IPs on port 443 (+ DNS).
   * Requires the container to have NET_ADMIN capability and iptables installed.
   */
  restrictNetwork(
    container: ContainerId,
    allowedIPs: string[],
  ): Promise<void>;

  /** Stop a running container. */
  stop(container: ContainerId): Promise<void>;

  /** Remove a container. */
  remove(container: ContainerId): Promise<void>;

  /** Remove all images matching a tag prefix. Returns the count removed. */
  removeImagesByPrefix(prefix: string): Promise<number>;
}
