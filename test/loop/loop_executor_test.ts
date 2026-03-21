import { assertEquals, assertStringIncludes } from "@std/assert";
import { MockRuntime } from "../runtime/mock_runtime.ts";
import { LoopExecutor } from "../../src/loop/loop_executor.ts";

function createExecutor(
  runtime: MockRuntime,
  overrides: Partial<{
    maxLoops: number;
    checkCommand: string;
    customPrompt: string;
    onLine: (line: string) => void;
  }> = {},
): LoopExecutor {
  return new LoopExecutor({
    runtime,
    containerId: "mock-container-1",
    model: "sonnet",
    task: "Write tests",
    maxLoops: overrides.maxLoops ?? 3,
    checkCommand: overrides.checkCommand,
    customPrompt: overrides.customPrompt,
    onLine: overrides.onLine,
  });
}

Deno.test("LoopExecutor", async (t) => {
  await t.step("detects KNOX_COMPLETE and stops", async () => {
    const runtime = new MockRuntime();
    runtime.execResults = [
      // mkdir
      { exitCode: 0, stdout: "", stderr: "" },
      // cat knox-progress.txt (not found)
      { exitCode: 1, stdout: "", stderr: "" },
      // git log (no commits)
      { exitCode: 1, stdout: "", stderr: "" },
    ];
    runtime.execStreamLines = [
      { line: "Working on it...", stream: "stdout" },
      { line: "KNOX_COMPLETE", stream: "stdout" },
    ];

    const executor = createExecutor(runtime);
    const result = await executor.run();

    assertEquals(result.completed, true);
    assertEquals(result.loopsRun, 1);
  });

  await t.step("runs up to maxLoops when no completion", async () => {
    const runtime = new MockRuntime();
    runtime.execResults = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
    ];
    runtime.execStreamLines = [
      { line: "Still working...", stream: "stdout" },
    ];

    const executor = createExecutor(runtime, { maxLoops: 2 });
    const result = await executor.run();

    assertEquals(result.completed, false);
    assertEquals(result.loopsRun, 2);
  });

  await t.step("streams output via onLine callback", async () => {
    const runtime = new MockRuntime();
    runtime.execResults = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
    ];
    runtime.execStreamLines = [
      { line: "line-one", stream: "stdout" },
      { line: "KNOX_COMPLETE", stream: "stdout" },
    ];

    const lines: string[] = [];
    const executor = createExecutor(runtime, {
      maxLoops: 1,
      onLine: (line) => lines.push(line),
    });
    await executor.run();

    assertEquals(lines, ["line-one", "KNOX_COMPLETE"]);
  });

  await t.step("reads progress file and git log before each loop", async () => {
    const runtime = new MockRuntime();
    runtime.execResults = [
      // mkdir
      { exitCode: 0, stdout: "", stderr: "" },
      // cat knox-progress.txt
      { exitCode: 0, stdout: "## Loop 1\nDid stuff", stderr: "" },
      // git log
      { exitCode: 0, stdout: "abc1234 feat: initial\n", stderr: "" },
    ];
    runtime.execStreamLines = [
      { line: "KNOX_COMPLETE", stream: "stdout" },
    ];

    const executor = createExecutor(runtime, { maxLoops: 1 });
    await executor.run();

    // Verify copyIn was called (prompt written to container)
    const copyInCalls = runtime.callsTo("copyIn");
    assertEquals(copyInCalls.length, 1);
    // Container path should be the prompt path
    assertEquals(copyInCalls[0].args[2], "/workspace/.knox/prompt.txt");
  });

  await t.step("invokes claude with correct flags", async () => {
    const runtime = new MockRuntime();
    runtime.execResults = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
    ];
    runtime.execStreamLines = [
      { line: "KNOX_COMPLETE", stream: "stdout" },
    ];

    const executor = createExecutor(runtime, { maxLoops: 1 });
    await executor.run();

    const streamCalls = runtime.callsTo("execStream");
    assertEquals(streamCalls.length, 1);
    const command = streamCalls[0].args[1] as string[];
    assertEquals(command[0], "sh");
    assertEquals(command[1], "-c");
    assertStringIncludes(command[2] as string, "claude -p");
    assertStringIncludes(command[2] as string, "--dangerously-skip-permissions");
    assertStringIncludes(command[2] as string, "--model sonnet");
  });

  await t.step("check command: passes when check succeeds", async () => {
    const runtime = new MockRuntime();
    runtime.execResults = [
      // mkdir
      { exitCode: 0, stdout: "", stderr: "" },
      // cat progress
      { exitCode: 1, stdout: "", stderr: "" },
      // git log
      { exitCode: 1, stdout: "", stderr: "" },
      // check command (passes)
      { exitCode: 0, stdout: "All tests passed", stderr: "" },
    ];
    runtime.execStreamLines = [
      { line: "KNOX_COMPLETE", stream: "stdout" },
    ];

    const executor = createExecutor(runtime, {
      maxLoops: 3,
      checkCommand: "npm test",
    });
    const result = await executor.run();

    assertEquals(result.completed, true);
    assertEquals(result.loopsRun, 1);
  });

  await t.step("check command: continues looping when check fails", async () => {
    const runtime = new MockRuntime();
    // We need different results per exec call, so we override exec
    let execCallCount = 0;
    runtime.exec = (container, command, options) => {
      runtime.calls.push({ method: "exec", args: [container, command, options] });
      execCallCount++;
      // Call 1: mkdir (loop 1)
      // Call 2: cat progress (loop 1)
      // Call 3: git log (loop 1)
      // Call 4: check command — FAILS
      // Call 5: mkdir (loop 2)
      // Call 6: cat progress (loop 2)
      // Call 7: git log (loop 2)
      // Call 8: check command — PASSES
      if (execCallCount === 4) {
        return Promise.resolve({ exitCode: 1, stdout: "FAIL", stderr: "test failed" });
      }
      if (execCallCount === 8) {
        return Promise.resolve({ exitCode: 0, stdout: "PASS", stderr: "" });
      }
      if (execCallCount % 4 === 2) {
        // cat progress — not found
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "" });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };
    runtime.execStreamLines = [
      { line: "KNOX_COMPLETE", stream: "stdout" },
    ];

    const executor = createExecutor(runtime, {
      maxLoops: 3,
      checkCommand: "npm test",
    });
    const result = await executor.run();

    assertEquals(result.completed, true);
    assertEquals(result.loopsRun, 2);
  });
});
