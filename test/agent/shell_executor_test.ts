import { assertEquals } from "@std/assert";
import { ShellExecutor } from "../../src/engine/agent/shell_executor.ts";
import type {
  ContainerHandle,
  ContainerProvider,
  InvokeResult,
  ShellContext,
} from "../../src/engine/agent/agent_provider.ts";
import type { ExecResult } from "../../src/shared/types.ts";

// ---------------------------------------------------------------------------
// Mock ContainerHandle
// ---------------------------------------------------------------------------

class MockContainerHandle implements ContainerHandle {
  exec(): Promise<ExecResult> {
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  }

  execStream(): Promise<number> {
    return Promise.resolve(0);
  }

  copyIn(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Mock ShellProvider
// ---------------------------------------------------------------------------

class MockShellProvider implements ContainerProvider<ShellContext> {
  invocations: ShellContext[] = [];
  result: InvokeResult = { completed: true, exitCode: 0 };

  async invoke(ctx: ShellContext): Promise<InvokeResult> {
    this.invocations.push(ctx);
    await Promise.resolve();
    return this.result;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("ShellExecutor", async (t) => {
  await t.step("invokes the provider exactly once", async () => {
    const provider = new MockShellProvider();
    const container = new MockContainerHandle();

    const executor = new ShellExecutor({
      provider,
      container,
      command: "echo hello",
    });
    await executor.run();

    assertEquals(provider.invocations.length, 1);
  });

  await t.step("passes command and container to provider", async () => {
    const provider = new MockShellProvider();
    const container = new MockContainerHandle();

    const executor = new ShellExecutor({
      provider,
      container,
      command: "ls -la",
    });
    await executor.run();

    assertEquals(provider.invocations[0].command, "ls -la");
    assertEquals(provider.invocations[0].container, container);
  });

  await t.step("passes onLine callback to provider", async () => {
    const provider = new MockShellProvider();
    const container = new MockContainerHandle();
    const onLine = (_line: string) => {};

    const executor = new ShellExecutor({
      provider,
      container,
      command: "echo hello",
      onLine,
    });
    await executor.run();

    assertEquals(provider.invocations[0].onLine, onLine);
  });

  await t.step(
    "returns InvokeResult from provider without modification",
    async () => {
      const provider = new MockShellProvider();
      provider.result = { completed: false, exitCode: 7 };
      const container = new MockContainerHandle();

      const executor = new ShellExecutor({
        provider,
        container,
        command: "exit 7",
      });
      const result = await executor.run();

      assertEquals(result.completed, false);
      assertEquals(result.exitCode, 7);
    },
  );

  await t.step("does not loop, retry, or commit-nudge", async () => {
    const provider = new MockShellProvider();
    provider.result = { completed: false, exitCode: 1 };
    const container = new MockContainerHandle();

    const executor = new ShellExecutor({
      provider,
      container,
      command: "false",
    });
    const result = await executor.run();

    // Even on failure, only one invocation — no retry
    assertEquals(provider.invocations.length, 1);
    assertEquals(result.completed, false);
    assertEquals(result.exitCode, 1);
  });
});
