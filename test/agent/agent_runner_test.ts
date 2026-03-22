import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { MockRuntime } from "../runtime/mock_runtime.ts";
import { ContainerSession } from "../../src/engine/session/container_session.ts";
import { AgentRunner } from "../../src/engine/agent/agent_runner.ts";
import type { SourceProvider } from "../../src/engine/source/source_provider.ts";
import { SourceStrategy } from "../../src/engine/source/source_provider.ts";
import type { PrepareResult } from "../../src/engine/source/source_provider.ts";

class MockSourceProvider implements SourceProvider {
  prepare(_runId: string): Promise<PrepareResult> {
    return Promise.resolve({
      hostPath: "/tmp/mock-source",
      metadata: {
        strategy: SourceStrategy.HostGit,
        baseCommit: "abc123",
        repoPath: "/mock/repo",
      },
    });
  }
  cleanup(_runId: string): Promise<void> {
    return Promise.resolve();
  }
}

async function createSession(runtime: MockRuntime): Promise<ContainerSession> {
  runtime.execResults = [
    { exitCode: 0, stdout: "", stderr: "" }, // chown
    { exitCode: 0, stdout: ".git", stderr: "" }, // git rev-parse
    { exitCode: 0, stdout: "", stderr: "" }, // exclude printf
  ];
  const session = await ContainerSession.create({
    runtime,
    runId: "test1234",
    runDir: "/tmp/knox-test1234",
    image: "knox-agent:latest",
    envVars: ["ANTHROPIC_API_KEY=test-key"],
    allowedIPs: ["1.2.3.4"],
    sourceProvider: new MockSourceProvider(),
  });
  // Reset calls so tests only see AgentRunner calls
  runtime.calls = [];
  return session;
}

function createRunner(
  session: ContainerSession,
  overrides: Partial<{
    maxLoops: number;
    checkCommand: string;
    customPrompt: string;
    onLine: (line: string) => void;
  }> = {},
): AgentRunner {
  return new AgentRunner({
    session,
    model: "sonnet",
    task: "Write tests",
    maxLoops: overrides.maxLoops ?? 3,
    checkCommand: overrides.checkCommand,
    customPrompt: overrides.customPrompt,
    onLine: overrides.onLine,
  });
}

Deno.test("AgentRunner", async (t) => {
  await t.step("detects KNOX_COMPLETE and stops", async () => {
    const runtime = new MockRuntime();
    const session = await createSession(runtime);

    runtime.execResults = [
      // mkdir
      { exitCode: 0, stdout: "", stderr: "" },
      // chown .knox
      { exitCode: 0, stdout: "", stderr: "" },
      // cat knox-progress.txt (not found)
      { exitCode: 1, stdout: "", stderr: "" },
      // git log (no commits)
      { exitCode: 1, stdout: "", stderr: "" },
      // hasDirtyTree (clean) — last result, MockRuntime sticks here
    ];
    runtime.execStreamLines = [
      { line: "Working on it...", stream: "stdout" },
      { line: "KNOX_COMPLETE", stream: "stdout" },
    ];

    const runner = createRunner(session);
    const result = await runner.run();

    assertEquals(result.completed, true);
    assertEquals(result.loopsRun, 1);
    assertEquals(result.autoCommitted, false);

    await session.dispose();
  });

  await t.step("runs up to maxLoops when no completion", async () => {
    const runtime = new MockRuntime();
    const session = await createSession(runtime);

    runtime.execResults = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
      // hasDirtyTree (clean) — last result
    ];
    runtime.execStreamLines = [
      { line: "Still working...", stream: "stdout" },
    ];

    const runner = createRunner(session, { maxLoops: 2 });
    const result = await runner.run();

    assertEquals(result.completed, false);
    assertEquals(result.loopsRun, 2);
    assertEquals(result.autoCommitted, false);

    await session.dispose();
  });

  await t.step("streams output via onLine callback", async () => {
    const runtime = new MockRuntime();
    const session = await createSession(runtime);

    runtime.execResults = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
    ];
    runtime.execStreamLines = [
      { line: "line-one", stream: "stdout" },
      { line: "KNOX_COMPLETE", stream: "stdout" },
    ];

    const lines: string[] = [];
    const runner = createRunner(session, {
      maxLoops: 1,
      onLine: (line) => lines.push(line),
    });
    await runner.run();

    assertEquals(lines, ["line-one", "KNOX_COMPLETE"]);

    await session.dispose();
  });

  await t.step("reads progress file and git log before each loop", async () => {
    const runtime = new MockRuntime();
    const session = await createSession(runtime);

    // Use exec override to control results precisely
    let execCallCount = 0;
    runtime.exec = (container, command, options) => {
      runtime.calls.push({ method: "exec", args: [container, command, options] });
      execCallCount++;
      // Call 1: mkdir, 2: chown, 3: cat progress, 4: git log, 5: hasDirtyTree
      if (execCallCount === 3) {
        return Promise.resolve({ exitCode: 0, stdout: "## Loop 1\nDid stuff", stderr: "" });
      }
      if (execCallCount === 4) {
        return Promise.resolve({ exitCode: 0, stdout: "abc1234 feat: initial\n", stderr: "" });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };
    runtime.execStreamLines = [
      { line: "KNOX_COMPLETE", stream: "stdout" },
    ];

    const runner = createRunner(session, { maxLoops: 1 });
    await runner.run();

    // Verify copyIn was called (prompt written to container)
    const copyInCalls = runtime.callsTo("copyIn");
    assertEquals(copyInCalls.length, 1);
    // Container path should be the prompt path
    assertEquals(copyInCalls[0].args[2], "/workspace/.knox/prompt.txt");

    await session.dispose();
  });

  await t.step("invokes claude with correct flags", async () => {
    const runtime = new MockRuntime();
    const session = await createSession(runtime);

    runtime.execResults = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
    ];
    runtime.execStreamLines = [
      { line: "KNOX_COMPLETE", stream: "stdout" },
    ];

    const runner = createRunner(session, { maxLoops: 1 });
    await runner.run();

    const streamCalls = runtime.callsTo("execStream");
    assertEquals(streamCalls.length, 1);
    const command = streamCalls[0].args[1] as string[];
    assertEquals(command[0], "sh");
    assertEquals(command[1], "-c");
    assertStringIncludes(command[2] as string, "claude -p");
    assertStringIncludes(
      command[2] as string,
      "--dangerously-skip-permissions",
    );
    assertStringIncludes(command[2] as string, "--model sonnet");

    await session.dispose();
  });

  await t.step("check command: passes when check succeeds", async () => {
    const runtime = new MockRuntime();
    const session = await createSession(runtime);

    // Use exec override since we need clean hasDirtyTree at the end
    let execCallCount = 0;
    runtime.exec = (container, command, options) => {
      runtime.calls.push({ method: "exec", args: [container, command, options] });
      execCallCount++;
      // Calls: 1=mkdir, 2=chown, 3=cat progress, 4=git log, 5=check, 6=hasDirtyTree
      if (execCallCount === 3 || execCallCount === 4) {
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "" });
      }
      if (execCallCount === 5) {
        return Promise.resolve({ exitCode: 0, stdout: "All tests passed", stderr: "" });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };
    runtime.execStreamLines = [
      { line: "KNOX_COMPLETE", stream: "stdout" },
    ];

    const runner = createRunner(session, {
      maxLoops: 3,
      checkCommand: "npm test",
    });
    const result = await runner.run();

    assertEquals(result.completed, true);
    assertEquals(result.loopsRun, 1);

    await session.dispose();
  });

  await t.step(
    "check command: continues looping when check fails",
    async () => {
      const runtime = new MockRuntime();
      const session = await createSession(runtime);

      let execCallCount = 0;
      runtime.exec = (container, command, options) => {
        runtime.calls.push({
          method: "exec",
          args: [container, command, options],
        });
        execCallCount++;
        // Call 1: mkdir (loop 1)
        // Call 2: chown .knox (loop 1)
        // Call 3: cat progress (loop 1)
        // Call 4: git log (loop 1)
        // Call 5: check command — FAILS
        // Call 6: mkdir (loop 2)
        // Call 7: chown .knox (loop 2)
        // Call 8: cat progress (loop 2)
        // Call 9: git log (loop 2)
        // Call 10: check command — PASSES
        // Call 11: hasDirtyTree — clean
        if (execCallCount === 5) {
          return Promise.resolve({
            exitCode: 1,
            stdout: "FAIL",
            stderr: "test failed",
          });
        }
        if (execCallCount === 10) {
          return Promise.resolve({ exitCode: 0, stdout: "PASS", stderr: "" });
        }
        if (execCallCount % 5 === 3) {
          // cat progress — not found
          return Promise.resolve({ exitCode: 1, stdout: "", stderr: "" });
        }
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      };
      runtime.execStreamLines = [
        { line: "KNOX_COMPLETE", stream: "stdout" },
      ];

      const runner = createRunner(session, {
        maxLoops: 3,
        checkCommand: "npm test",
      });
      const result = await runner.run();

      assertEquals(result.completed, true);
      assertEquals(result.loopsRun, 2);

      await session.dispose();
    },
  );

  // --- Commit nudge tests ---

  await t.step("clean tree skips nudge entirely", async () => {
    const runtime = new MockRuntime();
    const session = await createSession(runtime);

    let execCallCount = 0;
    runtime.exec = (container, command, options) => {
      runtime.calls.push({ method: "exec", args: [container, command, options] });
      execCallCount++;
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };
    runtime.execStreamLines = [
      { line: "KNOX_COMPLETE", stream: "stdout" },
    ];

    const runner = createRunner(session, { maxLoops: 1 });
    const result = await runner.run();

    assertEquals(result.autoCommitted, false);
    // Only 1 execStream call (the loop), no nudge execStream
    const streamCalls = runtime.callsTo("execStream");
    assertEquals(streamCalls.length, 1);

    await session.dispose();
  });

  await t.step("dirty tree triggers nudge, successful nudge returns autoCommitted=false", async () => {
    const runtime = new MockRuntime();
    const session = await createSession(runtime);

    let statusCallCount = 0;
    runtime.exec = (container, command, options) => {
      runtime.calls.push({ method: "exec", args: [container, command, options] });
      // git status --porcelain
      if (
        Array.isArray(command) &&
        command[0] === "git" && command[1] === "status" &&
        command.includes("--porcelain")
      ) {
        statusCallCount++;
        // First: dirty, second: clean (nudge succeeded)
        if (statusCallCount === 1) {
          return Promise.resolve({ exitCode: 0, stdout: " M dirty.ts\n", stderr: "" });
        }
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };
    runtime.execStreamLines = [
      { line: "KNOX_COMPLETE", stream: "stdout" },
    ];

    const runner = createRunner(session, { maxLoops: 1 });
    const result = await runner.run();

    assertEquals(result.autoCommitted, false);
    // 2 execStream calls: 1 loop + 1 nudge
    const streamCalls = runtime.callsTo("execStream");
    assertEquals(streamCalls.length, 2);

    await session.dispose();
  });

  await t.step("failed nudge falls back to auto-commit, returns autoCommitted=true", async () => {
    const runtime = new MockRuntime();
    const session = await createSession(runtime);

    // Always return dirty for git status
    runtime.exec = (container, command, options) => {
      runtime.calls.push({ method: "exec", args: [container, command, options] });
      if (
        Array.isArray(command) &&
        command[0] === "git" && command[1] === "status" &&
        command.includes("--porcelain")
      ) {
        return Promise.resolve({ exitCode: 0, stdout: " M dirty.ts\n", stderr: "" });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };
    runtime.execStreamLines = [
      { line: "KNOX_COMPLETE", stream: "stdout" },
    ];

    const runner = createRunner(session, { maxLoops: 1 });
    const result = await runner.run();

    assertEquals(result.autoCommitted, true);

    // Should see the auto-commit exec call
    const execCalls = runtime.callsTo("exec");
    const autoCommitCall = execCalls.find((c) => {
      const cmd = c.args[1] as string[];
      return cmd.some((a) =>
        typeof a === "string" && a.includes("auto-commit")
      );
    });
    assert(autoCommitCall !== undefined, "auto-commit exec should exist");

    await session.dispose();
  });
});
