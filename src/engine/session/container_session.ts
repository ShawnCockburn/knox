import type {
  ContainerRuntime,
  ExecOptions,
  OnLineCallback,
} from "../../shared/runtime/container_runtime.ts";
import type { ContainerId, ExecResult, ImageId } from "../../shared/types.ts";
import type { SourceProvider } from "../source/source_provider.ts";
import type { SourceMetadata } from "../source/source_provider.ts";
import { log } from "../../shared/log.ts";

/** Container-internal path constants. Only ContainerSession knows these. */
const WORKSPACE = "/workspace";
const BUNDLE_PATH = "/tmp/knox.bundle";

export interface ContainerSessionOptions {
  readonly runtime: ContainerRuntime;
  readonly runId: string;
  readonly runDir: string;
  readonly image: ImageId;
  readonly envVars: string[];
  readonly allowedIPs: string[];
  readonly sourceProvider: SourceProvider;
  readonly cpuLimit?: string;
  readonly memoryLimit?: string;
}

/**
 * Owns the lifecycle of a sandboxed container: creation, workspace setup,
 * network restriction, and teardown. All container-internal paths are
 * encapsulated here — callers never reference /workspace or container IDs
 * directly (after Phase 2).
 */
export class ContainerSession {
  private readonly runtime: ContainerRuntime;
  private readonly _containerId: ContainerId;
  private readonly _runDir: string;
  private readonly _metadata: SourceMetadata;
  private disposed = false;

  private constructor(
    runtime: ContainerRuntime,
    containerId: ContainerId,
    runDir: string,
    metadata: SourceMetadata,
  ) {
    this.runtime = runtime;
    this._containerId = containerId;
    this._runDir = runDir;
    this._metadata = metadata;
  }

  /** The container ID — exposed for Knox during transitional phases. */
  get containerId(): ContainerId {
    return this._containerId;
  }

  /** Source metadata captured during creation. */
  get metadata(): SourceMetadata {
    return this._metadata;
  }

  /**
   * Create a sandboxed container with source copied in, network restricted,
   * and git verified. This is the only way to obtain a ContainerSession.
   */
  static async create(
    options: ContainerSessionOptions,
  ): Promise<ContainerSession> {
    const {
      runtime,
      runId,
      runDir,
      image,
      envVars,
      allowedIPs,
      sourceProvider,
      cpuLimit,
      memoryLimit,
    } = options;

    // Prepare source
    log.info(`Preparing source...`);
    const prepareResult = await sourceProvider.prepare(runId);
    for (const warning of prepareResult.warnings ?? []) {
      log.warn(warning);
    }

    // Create container
    log.info(`Creating container (API-only network)...`);
    const containerId = await runtime.createContainer({
      image,
      name: `knox-${runId}`,
      workdir: WORKSPACE,
      env: envVars,
      networkEnabled: true,
      capAdd: ["NET_ADMIN"],
      cpuLimit,
      memoryLimit,
    });
    log.debug(`Container: ${containerId}`);

    // Copy source into container and fix ownership
    log.info(`Copying source into container...`);
    await runtime.copyIn(
      containerId,
      prepareResult.hostPath + "/.",
      WORKSPACE,
    );
    await runtime.exec(
      containerId,
      ["chown", "-R", "knox:knox", WORKSPACE],
      { user: "root" },
    );

    // Cleanup source temp files
    await sourceProvider.cleanup(runId);

    // Lock down network to API-only egress
    await runtime.restrictNetwork(containerId, allowedIPs);
    log.debug(`Network restricted to API endpoints only`);

    // Verify git repo exists in workspace
    const gitCheck = await runtime.exec(containerId, [
      "sh",
      "-c",
      `cd ${WORKSPACE} && git rev-parse --git-dir`,
    ]);
    if (gitCheck.exitCode !== 0) {
      // Clean up container before throwing
      await runtime.remove(containerId).catch(() => {});
      throw new Error(
        "No .git directory in workspace after source copy — aborting",
      );
    }

    // Exclude knox internal files from agent commits
    await runtime.exec(containerId, [
      "sh",
      "-c",
      `cd ${WORKSPACE} && printf 'knox-progress.txt\\n.knox/\\n' >> .git/info/exclude`,
    ]);

    return new ContainerSession(
      runtime,
      containerId,
      runDir,
      prepareResult.metadata,
    );
  }

  /** Execute a command in the workspace. */
  exec(command: string[], options?: ExecOptions): Promise<ExecResult> {
    return this.runtime.exec(this._containerId, command, {
      workdir: WORKSPACE,
      ...options,
    });
  }

  /** Execute a command and stream output line-by-line. */
  execStream(
    command: string[],
    options: ExecOptions & { onLine: OnLineCallback },
  ): Promise<number> {
    return this.runtime.execStream(this._containerId, command, {
      workdir: WORKSPACE,
      ...options,
    });
  }

  /** Check whether the workspace has uncommitted changes. */
  async hasDirtyTree(): Promise<boolean> {
    const result = await this.exec(
      ["git", "status", "--porcelain"],
    );
    return result.stdout.trim().length > 0;
  }

  /** Copy a file from the host into the container. */
  copyIn(hostPath: string, containerPath: string): Promise<void> {
    return this.runtime.copyIn(this._containerId, hostPath, containerPath);
  }

  /** Create a git bundle inside the container and copy it to the host run directory. Returns host-side bundle path. */
  async extractBundle(): Promise<string> {
    const bundleResult = await this.exec(
      ["git", "bundle", "create", BUNDLE_PATH, "HEAD"],
    );
    if (bundleResult.exitCode !== 0) {
      throw new Error(`git bundle create failed: ${bundleResult.stderr}`);
    }
    const hostBundlePath = `${this._runDir}/bundle.git`;
    await this.runtime.copyOut(
      this._containerId,
      BUNDLE_PATH,
      hostBundlePath,
    );
    return hostBundlePath;
  }

  /** Remove the container. Safe to call multiple times. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    log.info(`Cleaning up container...`);
    await this.runtime.remove(this._containerId);
  }
}
