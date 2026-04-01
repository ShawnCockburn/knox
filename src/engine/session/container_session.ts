import type {
  ContainerRuntime,
  ExecOptions,
  OnLineCallback,
} from "../../shared/runtime/container_runtime.ts";
import type { ContainerId, ExecResult, ImageId } from "../../shared/types.ts";
import type { SourceProvider } from "../source/source_provider.ts";
import type { SourceMetadata } from "../source/source_provider.ts";
import type { ContainerHandle } from "../agent/agent_provider.ts";
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
  readonly projectSetup?: string;
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
      projectSetup,
    } = options;

    // Prepare source
    log.debug(`[session] Preparing source for run ${runId}...`);
    log.info(`Preparing source...`);
    const prepareResult = await sourceProvider.prepare(runId);
    log.debug(`[session] Source prepared: hostPath=${prepareResult.hostPath}`);
    log.debug(
      `[session] Source metadata: ${JSON.stringify(prepareResult.metadata)}`,
    );
    for (const warning of prepareResult.warnings ?? []) {
      log.warn(warning);
    }

    // Create container
    log.info(`Creating container (API-only network)...`);
    const containerEnv = [
      ...envVars,
      // Prevent Claude Code from checking npm for updates (network is restricted)
      "DISABLE_AUTOUPDATE=1",
    ];
    log.debug(`[session] Image: ${image}`);
    log.debug(
      `[session] Env vars: ${
        containerEnv.map((e) => e.split("=")[0]).join(", ")
      }`,
    );
    log.debug(
      `[session] CPU: ${cpuLimit ?? "default"}, Memory: ${
        memoryLimit ?? "default"
      }`,
    );
    const containerId = await runtime.createContainer({
      image,
      name: `knox-${runId}`,
      workdir: WORKSPACE,
      env: containerEnv,
      networkEnabled: true,
      capAdd: ["NET_ADMIN"],
      cpuLimit,
      memoryLimit,
    });
    log.debug(`[session] Container created: ${containerId}`);

    // Copy source into container and fix ownership
    log.info(`Copying source into container...`);
    log.debug(`[session] Copying ${prepareResult.hostPath}/. → ${WORKSPACE}`);
    await runtime.copyIn(
      containerId,
      prepareResult.hostPath + "/.",
      WORKSPACE,
    );
    log.debug(`[session] Source copied, fixing ownership...`);
    const chownResult = await runtime.exec(
      containerId,
      ["chown", "-R", "knox:knox", WORKSPACE],
      { user: "root" },
    );
    if (chownResult.exitCode !== 0) {
      log.debug(
        `[session] chown failed (exit ${chownResult.exitCode}): ${chownResult.stderr}`,
      );
    } else {
      log.debug(`[session] Ownership fixed`);
    }

    // Cleanup source temp files
    log.debug(`[session] Cleaning up source temp files...`);
    await sourceProvider.cleanup(runId);

    // Run projectSetup command (after source copy, before network restriction)
    if (projectSetup) {
      log.info(`Running project setup...`);
      log.debug(`[session] projectSetup: ${projectSetup}`);
      const setupResult = await runtime.exec(
        containerId,
        ["sh", "-c", projectSetup],
        { workdir: WORKSPACE },
      );
      if (setupResult.exitCode !== 0) {
        log.debug(
          `[session] projectSetup failed (exit ${setupResult.exitCode}): ${setupResult.stderr}`,
        );
        await runtime.remove(containerId).catch(() => {});
        throw new Error(
          `projectSetup command failed (exit ${setupResult.exitCode}): ${setupResult.stderr}`,
        );
      }
      log.debug(`[session] projectSetup completed`);
    }

    // Lock down network to API-only egress
    log.debug(
      `[session] Restricting network to ${allowedIPs.length} IPs: ${
        allowedIPs.join(", ")
      }`,
    );
    await runtime.restrictNetwork(containerId, allowedIPs);
    log.debug(`[session] Network restricted`);

    // Verify git repo exists in workspace
    log.debug(`[session] Verifying git repo in workspace...`);
    const gitCheck = await runtime.exec(containerId, [
      "sh",
      "-c",
      `cd ${WORKSPACE} && git rev-parse --git-dir`,
    ]);
    if (gitCheck.exitCode !== 0) {
      log.debug(
        `[session] git check failed: stdout=${gitCheck.stdout} stderr=${gitCheck.stderr}`,
      );
      // Clean up container before throwing
      await runtime.remove(containerId).catch(() => {});
      throw new Error(
        "No .git directory in workspace after source copy — aborting",
      );
    }
    log.debug(`[session] Git repo verified: ${gitCheck.stdout.trim()}`);

    // Exclude knox internal files from agent commits
    log.debug(`[session] Setting up git exclude...`);
    const excludeResult = await runtime.exec(containerId, [
      "sh",
      "-c",
      `cd ${WORKSPACE} && printf 'knox-progress.txt\\n.knox/\\n' >> .git/info/exclude`,
    ]);
    if (excludeResult.exitCode !== 0) {
      log.debug(
        `[session] git exclude setup failed (exit ${excludeResult.exitCode}): ${excludeResult.stderr}`,
      );
    } else {
      log.debug(`[session] Git exclude configured`);
    }

    log.debug(`[session] Container session ready: ${containerId}`);
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
    log.debug(`[session] Checking for dirty tree...`);
    const result = await this.exec(
      ["git", "status", "--porcelain"],
    );
    const dirty = result.stdout.trim().length > 0;
    log.debug(`[session] Dirty tree: ${dirty}`);
    return dirty;
  }

  /** Copy a file from the host into the container. */
  copyIn(hostPath: string, containerPath: string): Promise<void> {
    return this.runtime.copyIn(this._containerId, hostPath, containerPath);
  }

  /** Return a narrow ContainerHandle for use by AgentProviders. */
  toContainerHandle(): ContainerHandle {
    return {
      exec: (command: string[], options?: ExecOptions): Promise<ExecResult> =>
        this.exec(command, options),
      execStream: (
        command: string[],
        options: ExecOptions & { onLine: OnLineCallback },
      ): Promise<number> => this.execStream(command, options),
      copyIn: (hostPath: string, containerPath: string): Promise<void> =>
        this.copyIn(hostPath, containerPath),
    };
  }

  /** Create a git bundle inside the container and copy it to the host run directory. Returns host-side bundle path. */
  async extractBundle(): Promise<string> {
    log.debug(`[session] Creating git bundle...`);
    const bundleResult = await this.exec(
      ["git", "bundle", "create", BUNDLE_PATH, "HEAD"],
    );
    if (bundleResult.exitCode !== 0) {
      throw new Error(`git bundle create failed: ${bundleResult.stderr}`);
    }
    log.debug(`[session] Bundle created at ${BUNDLE_PATH}`);
    const hostBundlePath = `${this._runDir}/bundle.git`;
    log.debug(`[session] Copying bundle to host: ${hostBundlePath}`);
    await this.runtime.copyOut(
      this._containerId,
      BUNDLE_PATH,
      hostBundlePath,
    );
    log.debug(`[session] Bundle extracted to ${hostBundlePath}`);
    return hostBundlePath;
  }

  /** Remove the container. Safe to call multiple times. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    log.debug(`[session] Disposing container ${this._containerId}...`);
    log.info(`Cleaning up container...`);
    await this.runtime.remove(this._containerId);
    log.debug(`[session] Container removed`);
  }
}
