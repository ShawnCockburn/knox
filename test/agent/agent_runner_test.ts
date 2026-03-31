import { assert, assertEquals } from "@std/assert";
import { AgentRunner } from "../../src/engine/agent/agent_runner.ts";
import type {
  AgentProvider,
  ContainerHandle,
  InvokeResult,
  LlmAgentContext,
} from "../../src/engine/agent/agent_provider.ts";
import type { ExecResult } from "../../src/shared/types.ts";
import type { ExecOptions } from "../../src/shared/runtime/container_runtime.ts";

// ---------------------------------------------------------------------------
// Mock AgentProvider
// ---------------------------------------------------------------------------

class MockAgentProvider implements AgentProvider<LlmAgentContext> {
  invocations: LlmAgentContext[] = [];
  results: InvokeResult[] = [];
  private resultIndex = 0;

  async invoke(ctx: LlmAgentContext): Promise<InvokeResult> {
    this.invocations.push(ctx);
    const result = this.results[this.resultIndex] ?? {
      completed: false,
      exitCode: 0,
    };
    if (this.resultIndex < this.results.length - 1) {
      this.resultIndex++;
    }
    // Simulate streaming output so onLine can fire if needed
    await Promise.resolve();
    return result;
  }
}

// ---------------------------------------------------------------------------
// Mock ContainerHandle
// ---------------------------------------------------------------------------

interface MockExecCall {
  command: string[];
  options?: ExecOptions;
}

class MockContainerHandle implements ContainerHandle {
  execCalls: MockExecCall[] = [];
  execResults: ExecResult[] = [];
  private execIndex = 0;

  execHandler?: (
    command: string[],
    options?: ExecOptions,
  ) => Promise<ExecResult>;

  exec(command: string[], options?: ExecOptions): Promise<ExecResult> {
    this.execCalls.push({ command, options });
    if (this.execHandler) return this.execHandler(command, options);
    const result = this.execResults[this.execIndex] ?? {
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
    if (this.execIndex < this.execResults.length - 1) {
      this.execIndex++;
    }
    return Promise.resolve(result);
  }

  execStream(): Promise<number> {
    return Promise.resolve(0);
  }

  copyIn(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRunner(
  provider: MockAgentProvider,
  container: MockContainerHandle,
  overrides: Partial<{
    maxLoops: number;
    checkCommand: string;
    customPrompt: string;
    onLine: (line: string) => void;
    signal: AbortSignal;
  }> = {},
): AgentRunner {
  return new AgentRunner({
    provider,
    container,
    task: "Write tests",
    maxLoops: overrides.maxLoops ?? 3,
    checkCommand: overrides.checkCommand,
    customPrompt: overrides.customPrompt,
    onLine: overrides.onLine,
    signal: overrides.signal,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("AgentRunner", async (t) => {
  await t.step("stops when provider returns completed: true", async () => {
    const provider = new MockAgentProvider();
    const container = new MockContainerHandle();

    provider.results = [{ completed: true, exitCode: 0 }];
    // hasDirtyTree → clean
    container.execResults = [{ exitCode: 0, stdout: "", stderr: "" }];

    const runner = createRunner(provider, container);
    const result = await runner.run();

    assertEquals(result.completed, true);
    assertEquals(result.loopsRun, 1);
    assertEquals(result.autoCommitted, false);
    assertEquals(provider.invocations.length, 1);
  });

  await t.step(
    "runs up to maxLoops when provider never completes",
    async () => {
      const provider = new MockAgentProvider();
      const container = new MockContainerHandle();

      provider.results = [{ completed: false, exitCode: 0 }];
      // hasDirtyTree → clean
      container.execResults = [{ exitCode: 0, stdout: "", stderr: "" }];

      const runner = createRunner(provider, container, { maxLoops: 2 });
      const result = await runner.run();

      assertEquals(result.completed, false);
      assertEquals(result.loopsRun, 2);
      assertEquals(provider.invocations.length, 2);
    },
  );

  await t.step(
    "retries on non-zero exit codes with backoff",
    async () => {
      const provider = new MockAgentProvider();
      const container = new MockContainerHandle();

      // First call: non-zero exit, second call: success with completion
      provider.results = [
        { completed: false, exitCode: 1 },
        { completed: true, exitCode: 0 },
      ];
      // hasDirtyTree → clean
      container.execResults = [{ exitCode: 0, stdout: "", stderr: "" }];

      const runner = createRunner(provider, container, { maxLoops: 1 });
      const result = await runner.run();

      assertEquals(result.completed, true);
      // Two invocations: one failed, one retry
      assertEquals(provider.invocations.length, 2);
    },
  );

  await t.step(
    "runs check command after completion and re-loops on failure",
    async () => {
      const provider = new MockAgentProvider();
      const container = new MockContainerHandle();

      // Both loops return completed
      provider.results = [{ completed: true, exitCode: 0 }];

      // check command: first fails, second passes
      let checkCallCount = 0;
      container.execHandler = (command) => {
        // git status --porcelain for hasDirtyTree → clean
        if (command[0] === "git" && command.includes("--porcelain")) {
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        }
        // check command (sh -c ...)
        if (command[0] === "sh" && command[1] === "-c") {
          checkCallCount++;
          if (checkCallCount === 1) {
            return Promise.resolve({
              exitCode: 1,
              stdout: "FAIL",
              stderr: "test failed",
            });
          }
          return Promise.resolve({
            exitCode: 0,
            stdout: "PASS",
            stderr: "",
          });
        }
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      };

      const runner = createRunner(provider, container, {
        maxLoops: 3,
        checkCommand: "npm test",
      });
      const result = await runner.run();

      assertEquals(result.completed, true);
      assertEquals(result.loopsRun, 2);
      // Provider invoked twice (once per loop)
      assertEquals(provider.invocations.length, 2);
      // Second invocation should have checkFailure context
      assertEquals(
        provider.invocations[1].checkFailure,
        "FAILtest failed",
      );
    },
  );

  await t.step(
    "nudge: detects dirty tree, calls invoke with commit instruction, falls back to auto-commit",
    async () => {
      const provider = new MockAgentProvider();
      const container = new MockContainerHandle();

      // Loop completes
      provider.results = [
        { completed: true, exitCode: 0 },
        // nudge invocation (provider doesn't commit)
        { completed: false, exitCode: 0 },
      ];

      // Always dirty for git status
      container.execHandler = (command) => {
        if (command[0] === "git" && command.includes("--porcelain")) {
          return Promise.resolve({
            exitCode: 0,
            stdout: " M dirty.ts\n",
            stderr: "",
          });
        }
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      };

      const runner = createRunner(provider, container);
      const result = await runner.run();

      assertEquals(result.autoCommitted, true);
      // 2 provider invocations: 1 loop + 1 nudge
      assertEquals(provider.invocations.length, 2);
      // Nudge invocation should have commit instruction as task
      assert(
        provider.invocations[1].task.includes("uncommitted changes"),
        "nudge task should mention uncommitted changes",
      );

      // Should have an auto-commit exec call
      const autoCommitCall = container.execCalls.find((c) =>
        c.command.some((a) =>
          typeof a === "string" && a.includes("auto-commit")
        )
      );
      assert(autoCommitCall !== undefined, "auto-commit exec should exist");
    },
  );

  await t.step(
    "nudge: successful nudge returns autoCommitted=false",
    async () => {
      const provider = new MockAgentProvider();
      const container = new MockContainerHandle();

      // Loop completes
      provider.results = [
        { completed: true, exitCode: 0 },
        // nudge invocation
        { completed: false, exitCode: 0 },
      ];

      let statusCallCount = 0;
      container.execHandler = (command) => {
        if (command[0] === "git" && command.includes("--porcelain")) {
          statusCallCount++;
          // First: dirty, second: clean (nudge committed)
          if (statusCallCount === 1) {
            return Promise.resolve({
              exitCode: 0,
              stdout: " M dirty.ts\n",
              stderr: "",
            });
          }
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        }
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      };

      const runner = createRunner(provider, container);
      const result = await runner.run();

      assertEquals(result.autoCommitted, false);
      // 2 provider invocations: 1 loop + 1 nudge
      assertEquals(provider.invocations.length, 2);
    },
  );

  await t.step("clean tree skips nudge entirely", async () => {
    const provider = new MockAgentProvider();
    const container = new MockContainerHandle();

    provider.results = [{ completed: true, exitCode: 0 }];
    // hasDirtyTree → clean
    container.execResults = [{ exitCode: 0, stdout: "", stderr: "" }];

    const runner = createRunner(provider, container, { maxLoops: 1 });
    const result = await runner.run();

    assertEquals(result.autoCommitted, false);
    // Only 1 provider invocation (the loop), no nudge
    assertEquals(provider.invocations.length, 1);
  });

  await t.step("respects abort signal", async () => {
    const provider = new MockAgentProvider();
    const container = new MockContainerHandle();

    provider.results = [{ completed: false, exitCode: 0 }];
    // hasDirtyTree → clean
    container.execResults = [{ exitCode: 0, stdout: "", stderr: "" }];

    const controller = new AbortController();
    controller.abort();

    const runner = createRunner(provider, container, {
      maxLoops: 5,
      signal: controller.signal,
    });
    const result = await runner.run();

    assertEquals(result.completed, false);
    assertEquals(result.loopsRun, 0);
    // Provider should never have been invoked
    assertEquals(provider.invocations.length, 0);
  });

  await t.step(
    "passes task, loop context, and customPrompt to provider",
    async () => {
      const provider = new MockAgentProvider();
      const container = new MockContainerHandle();

      provider.results = [{ completed: true, exitCode: 0 }];
      // hasDirtyTree → clean
      container.execResults = [{ exitCode: 0, stdout: "", stderr: "" }];

      const runner = createRunner(provider, container, {
        maxLoops: 5,
        customPrompt: "Custom system prompt",
      });
      await runner.run();

      assertEquals(provider.invocations.length, 1);
      const ctx = provider.invocations[0];
      assertEquals(ctx.task, "Write tests");
      assertEquals(ctx.loopNumber, 1);
      assertEquals(ctx.maxLoops, 5);
      assertEquals(ctx.customPrompt, "Custom system prompt");
      assertEquals(ctx.checkFailure, undefined);
    },
  );
});
