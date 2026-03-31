import { assertEquals } from "@std/assert";
import { ShellProvider } from "../../src/engine/agent/shell_provider.ts";
import type { ContainerHandle } from "../../src/engine/agent/agent_provider.ts";
import type { ExecResult } from "../../src/shared/types.ts";
import type {
  ExecOptions,
  OnLineCallback,
} from "../../src/shared/runtime/container_runtime.ts";

// ---------------------------------------------------------------------------
// Mock ContainerHandle
// ---------------------------------------------------------------------------

class MockContainerHandle implements ContainerHandle {
  streamCalls: { command: string[] }[] = [];
  streamLines: { line: string; stream: "stdout" | "stderr" }[] = [];
  streamExitCode = 0;

  exec(): Promise<ExecResult> {
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  }

  execStream(
    command: string[],
    options: ExecOptions & { onLine: OnLineCallback },
  ): Promise<number> {
    this.streamCalls.push({ command });
    for (const { line, stream } of this.streamLines) {
      options.onLine(line, stream);
    }
    return Promise.resolve(this.streamExitCode);
  }

  copyIn(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("ShellProvider", async (t) => {
  await t.step("passes command as sh -c to container", async () => {
    const container = new MockContainerHandle();
    container.streamLines = [{ line: "hello", stream: "stdout" }];

    const provider = new ShellProvider();
    await provider.invoke({ container, command: "echo hello" });

    assertEquals(container.streamCalls.length, 1);
    assertEquals(container.streamCalls[0].command, ["sh", "-c", "echo hello"]);
  });

  await t.step("returns completed: true on exit code 0", async () => {
    const container = new MockContainerHandle();
    container.streamExitCode = 0;

    const provider = new ShellProvider();
    const result = await provider.invoke({ container, command: "true" });

    assertEquals(result.completed, true);
    assertEquals(result.exitCode, 0);
  });

  await t.step("returns completed: false on non-zero exit code", async () => {
    const container = new MockContainerHandle();
    container.streamExitCode = 42;

    const provider = new ShellProvider();
    const result = await provider.invoke({ container, command: "exit 42" });

    assertEquals(result.completed, false);
    assertEquals(result.exitCode, 42);
  });

  await t.step("streams output through onLine callback", async () => {
    const container = new MockContainerHandle();
    container.streamLines = [
      { line: "line-one", stream: "stdout" },
      { line: "line-two", stream: "stdout" },
      { line: "err-line", stream: "stderr" },
    ];

    const lines: string[] = [];
    const provider = new ShellProvider();
    await provider.invoke({
      container,
      command: "echo hello",
      onLine: (line) => lines.push(line),
    });

    assertEquals(lines, ["line-one", "line-two", "err-line"]);
  });

  await t.step("works without onLine callback", async () => {
    const container = new MockContainerHandle();
    container.streamLines = [{ line: "output", stream: "stdout" }];

    const provider = new ShellProvider();
    const result = await provider.invoke({ container, command: "echo hello" });

    assertEquals(result.completed, true);
  });
});
