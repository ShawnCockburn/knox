import type {
  BuildImageOptions,
  CommitOptions,
  ContainerId,
  CreateContainerOptions,
  ExecResult,
  ImageId,
} from "../../src/shared/types.ts";
import type {
  ContainerRuntime,
  ExecOptions,
  OnLineCallback,
} from "../../src/shared/runtime/container_runtime.ts";

/** Recorded call to the mock runtime. */
export interface MockCall {
  method: string;
  args: unknown[];
}

/** Mock ContainerRuntime that records calls and returns canned results. */
export class MockRuntime implements ContainerRuntime {
  calls: MockCall[] = [];
  execResults: ExecResult[] = [];
  execStreamLines: { line: string; stream: "stdout" | "stderr" }[] = [];
  execStreamExitCode = 0;
  imageExistsResult = false;
  private execResultIndex = 0;

  private record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
  }

  callsTo(method: string): MockCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  buildImage(options: BuildImageOptions): Promise<ImageId> {
    this.record("buildImage", options);
    return Promise.resolve(options.tag);
  }

  imageExists(tag: string): Promise<boolean> {
    this.record("imageExists", tag);
    return Promise.resolve(this.imageExistsResult);
  }

  createContainer(options: CreateContainerOptions): Promise<ContainerId> {
    this.record("createContainer", options);
    return Promise.resolve("mock-container-1");
  }

  exec(
    container: ContainerId,
    command: string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    this.record("exec", container, command, options);
    const result = this.execResults[this.execResultIndex] ?? {
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
    if (this.execResultIndex < this.execResults.length - 1) {
      this.execResultIndex++;
    }
    return Promise.resolve(result);
  }

  execStream(
    container: ContainerId,
    command: string[],
    options: ExecOptions & { onLine: OnLineCallback },
  ): Promise<number> {
    this.record("execStream", container, command, {
      workdir: options.workdir,
      env: options.env,
    });
    for (const { line, stream } of this.execStreamLines) {
      options.onLine(line, stream);
    }
    return Promise.resolve(this.execStreamExitCode);
  }

  copyIn(
    container: ContainerId,
    hostPath: string,
    containerPath: string,
  ): Promise<void> {
    this.record("copyIn", container, hostPath, containerPath);
    return Promise.resolve();
  }

  copyOut(
    container: ContainerId,
    containerPath: string,
    hostPath: string,
  ): Promise<void> {
    this.record("copyOut", container, containerPath, hostPath);
    return Promise.resolve();
  }

  restrictNetwork(
    container: ContainerId,
    allowedIPs: string[],
  ): Promise<void> {
    this.record("restrictNetwork", container, allowedIPs);
    return Promise.resolve();
  }

  commit(options: CommitOptions): Promise<ImageId> {
    this.record("commit", options);
    return Promise.resolve(options.tag);
  }

  stop(container: ContainerId): Promise<void> {
    this.record("stop", container);
    return Promise.resolve();
  }

  remove(container: ContainerId): Promise<void> {
    this.record("remove", container);
    return Promise.resolve();
  }
}
