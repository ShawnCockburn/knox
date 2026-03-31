import { assertEquals } from "@std/assert";
import { DockerRuntime } from "../../src/shared/runtime/docker_runtime.ts";
import { ShellProvider } from "../../src/engine/agent/shell_provider.ts";
import { ShellExecutor } from "../../src/engine/agent/shell_executor.ts";
import type { ContainerHandle } from "../../src/engine/agent/agent_provider.ts";
import type {
  ExecOptions,
  OnLineCallback,
} from "../../src/shared/runtime/container_runtime.ts";
import type { ExecResult } from "../../src/shared/types.ts";

const runtime = new DockerRuntime();

/** Build a ContainerHandle from a raw container ID + runtime. */
function makeHandle(containerId: string): ContainerHandle {
  return {
    exec: (command: string[], options?: ExecOptions): Promise<ExecResult> =>
      runtime.exec(containerId, command, options),
    execStream: (
      command: string[],
      options: ExecOptions & { onLine: OnLineCallback },
    ): Promise<number> => runtime.execStream(containerId, command, options),
    copyIn: (hostPath: string, containerPath: string): Promise<void> =>
      runtime.copyIn(containerId, hostPath, containerPath),
  };
}

Deno.test("ShellExecutor integration", async (t) => {
  let containerId: string | undefined;

  try {
    containerId = await runtime.createContainer({
      image: "ubuntu:latest",
      workdir: "/workspace",
    });

    const handle = makeHandle(containerId);
    const provider = new ShellProvider();

    await t.step("echo hello returns completed: true", async () => {
      const lines: string[] = [];
      const executor = new ShellExecutor({
        provider,
        container: handle,
        command: "echo hello",
        onLine: (line) => lines.push(line),
      });

      const result = await executor.run();

      assertEquals(result.completed, true);
      assertEquals(result.exitCode, 0);
      assertEquals(lines.some((l) => l.includes("hello")), true);
    });

    await t.step("failing command returns completed: false", async () => {
      const executor = new ShellExecutor({
        provider,
        container: handle,
        command: "exit 1",
      });

      const result = await executor.run();

      assertEquals(result.completed, false);
      assertEquals(result.exitCode, 1);
    });
  } finally {
    if (containerId) {
      await runtime.remove(containerId);
    }
  }
});
