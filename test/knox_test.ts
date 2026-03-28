import { assert, assertEquals } from "@std/assert";
import { MockRuntime } from "./runtime/mock_runtime.ts";
import { Knox } from "../src/engine/knox.ts";
import type { SourceProvider } from "../src/engine/source/source_provider.ts";
import { SourceStrategy } from "../src/engine/source/source_provider.ts";
import type { PrepareResult } from "../src/engine/source/source_provider.ts";
import type { ResultSink, SinkResult } from "../src/engine/sink/result_sink.ts";
import type { CollectOptions } from "../src/engine/sink/result_sink.ts";
import { SinkStrategy } from "../src/engine/sink/result_sink.ts";

class MockSourceProvider implements SourceProvider {
  prepareCalled = false;
  cleanupCalled = false;
  lastRunId = "";

  prepare(runId: string): Promise<PrepareResult> {
    this.prepareCalled = true;
    this.lastRunId = runId;
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
    this.cleanupCalled = true;
    return Promise.resolve();
  }
}

class MockResultSink implements ResultSink {
  collectCalled = false;
  cleanupCalled = false;
  lastOptions: CollectOptions | null = null;

  collect(options: CollectOptions): Promise<SinkResult> {
    this.collectCalled = true;
    this.lastOptions = options;
    return Promise.resolve({
      strategy: SinkStrategy.HostGit,
      branchName: `knox/test-task-${options.runId}`,
      commitCount: 1,
      autoCommitted: options.autoCommitted,
    });
  }

  cleanup(_runId: string): Promise<void> {
    this.cleanupCalled = true;
    return Promise.resolve();
  }
}

function setupMockRuntime(): MockRuntime {
  const runtime = new MockRuntime();
  runtime.imageExistsResult = true;

  runtime.exec = (container, command, options) => {
    runtime.calls.push({ method: "exec", args: [container, command, options] });
    // git status --porcelain (for commit nudge check): return clean
    if (
      command[0] === "git" && command[1] === "status" &&
      command.includes("--porcelain")
    ) {
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    }
    // git bundle create
    if (command[0] === "git" && command[1] === "bundle") {
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    }
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  };

  runtime.execStreamLines = [
    { line: "Working...", stream: "stdout" },
    { line: "KNOX_COMPLETE", stream: "stdout" },
  ];

  return runtime;
}

/** Common engine options — all pre-container work already resolved. */
function engineOpts(
  runtime: MockRuntime,
  overrides: Record<string, unknown> = {},
) {
  return {
    task: "Test task",
    dir: Deno.cwd(),
    image: "knox-agent:latest",
    envVars: ["ANTHROPIC_API_KEY=test-key"],
    allowedIPs: ["1.2.3.4"],
    maxLoops: 1,
    model: "sonnet",
    runtime,
    onLine: () => {},
    ...overrides,
  };
}

import type { KnoxOutcome } from "../src/engine/knox.ts";

/** Unwrap a KnoxOutcome, failing the test if not ok. */
function unwrap(outcome: KnoxOutcome) {
  assert(
    outcome.ok,
    `Expected ok outcome, got: ${!outcome.ok ? outcome.error : ""}`,
  );
  return outcome.result;
}

Deno.test("Knox orchestrator", async (t) => {
  await t.step("wires source and sink in correct order", async () => {
    const runtime = setupMockRuntime();
    const source = new MockSourceProvider();
    const sink = new MockResultSink();

    const knox = new Knox({
      ...engineOpts(runtime),
      sourceProvider: source,
      resultSink: sink,
    });

    const outcome = await knox.run();
    const result = unwrap(outcome);

    // Source was prepared and cleaned up
    assertEquals(source.prepareCalled, true);
    assertEquals(source.cleanupCalled, true);

    // Sink was collected and cleaned up
    assertEquals(sink.collectCalled, true);
    assertEquals(sink.cleanupCalled, true);

    // Verify orchestration order
    const methods = runtime.calls.map((c) => c.method);
    assertEquals(methods.includes("createContainer"), true);
    assertEquals(methods.includes("copyIn"), true);
    assertEquals(methods.includes("execStream"), true);

    // remove should be the last call (cleanup)
    assertEquals(methods[methods.length - 1], "remove");

    // Result has correct shape
    assertEquals(result.completed, true);
    assertEquals(result.loopsRun, 1);
    assertEquals(result.maxLoops, 1);
    assertEquals(result.model, "sonnet");
    assertEquals(result.task, "Test task");
    assertEquals(result.autoCommitted, false);
    assertEquals(result.checkPassed, null); // no --check
    assertEquals(result.sink.strategy, SinkStrategy.HostGit);
    assert(result.runId.length === 8, "runId should be 8 hex chars");
  });

  await t.step("run ID propagates to source, sink, and container", async () => {
    const runtime = setupMockRuntime();
    const source = new MockSourceProvider();
    const sink = new MockResultSink();

    const knox = new Knox({
      ...engineOpts(runtime),
      sourceProvider: source,
      resultSink: sink,
    });

    const outcome = await knox.run();
    const result = unwrap(outcome);

    // Source and sink received the same run ID
    const runId = source.lastRunId;
    assert(runId.length === 8, "runId should be 8 hex chars");
    assertEquals(sink.lastOptions!.runId, runId);
    assertEquals(result.runId, runId);

    // Container name includes runId
    const createCall = runtime.callsTo("createContainer")[0];
    const createOpts = createCall.args[0] as { name: string };
    assertEquals(createOpts.name, `knox-${runId}`);
  });

  await t.step("run ID passthrough from options", async () => {
    const runtime = setupMockRuntime();
    const source = new MockSourceProvider();
    const sink = new MockResultSink();

    const knox = new Knox({
      ...engineOpts(runtime, { runId: "deadbeef" }),
      sourceProvider: source,
      resultSink: sink,
    });

    const outcome = await knox.run();
    const result = unwrap(outcome);
    assertEquals(result.runId, "deadbeef");
    assertEquals(source.lastRunId, "deadbeef");
  });

  await t.step("KnoxResult includes timing metadata", async () => {
    const runtime = setupMockRuntime();
    const source = new MockSourceProvider();
    const sink = new MockResultSink();

    const before = new Date().toISOString();
    const knox = new Knox({
      ...engineOpts(runtime, { task: "Timing test" }),
      sourceProvider: source,
      resultSink: sink,
    });

    const result = unwrap(await knox.run());
    const after = new Date().toISOString();

    assert(result.startedAt >= before);
    assert(result.finishedAt <= after);
    assert(result.durationMs >= 0);
  });

  await t.step("checkPassed is true when completed with check", async () => {
    const runtime = setupMockRuntime();
    const source = new MockSourceProvider();
    const sink = new MockResultSink();

    const knox = new Knox({
      ...engineOpts(runtime, { task: "Check test", check: "echo ok" }),
      sourceProvider: source,
      resultSink: sink,
    });

    const result = unwrap(await knox.run());
    assertEquals(result.checkPassed, true);
  });

  await t.step("commit nudge triggers on dirty container tree", async () => {
    const runtime = setupMockRuntime();
    const source = new MockSourceProvider();
    const sink = new MockResultSink();

    let statusCallCount = 0;
    runtime.exec = (container, command, options) => {
      runtime.calls.push({
        method: "exec",
        args: [container, command, options],
      });
      // First git status --porcelain: dirty; second: clean (nudge worked)
      if (
        command[0] === "git" && command[1] === "status" &&
        command.includes("--porcelain")
      ) {
        statusCallCount++;
        if (statusCallCount === 1) {
          return Promise.resolve({
            exitCode: 0,
            stdout: " M dirty.ts\n",
            stderr: "",
          });
        }
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      if (command[0] === "git" && command[1] === "bundle") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };

    const knox = new Knox({
      ...engineOpts(runtime, { task: "Nudge test" }),
      sourceProvider: source,
      resultSink: sink,
    });

    const result = unwrap(await knox.run());

    // Nudge should have triggered an execStream call with the nudge prompt
    const streamCalls = runtime.callsTo("execStream");
    assertEquals(streamCalls.length, 2); // 1 loop + 1 nudge
    assertEquals(result.autoCommitted, false); // nudge succeeded
  });

  await t.step(
    "auto-commit triggers when nudge fails to commit",
    async () => {
      const runtime = setupMockRuntime();
      const source = new MockSourceProvider();
      const sink = new MockResultSink();

      // Always return dirty for git status --porcelain
      runtime.exec = (container, command, options) => {
        runtime.calls.push({
          method: "exec",
          args: [container, command, options],
        });
        if (
          command[0] === "git" && command[1] === "status" &&
          command.includes("--porcelain")
        ) {
          return Promise.resolve({
            exitCode: 0,
            stdout: " M dirty.ts\n",
            stderr: "",
          });
        }
        if (command[0] === "git" && command[1] === "bundle") {
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        }
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      };

      const knox = new Knox({
        ...engineOpts(runtime, { task: "Auto-commit test" }),
        sourceProvider: source,
        resultSink: sink,
      });

      const result = unwrap(await knox.run());
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
    },
  );

  await t.step("defaults to GitSourceProvider and GitBranchSink", () => {
    const runtime = setupMockRuntime();

    // This verifies no crash when using defaults (won't actually clone/fetch
    // because mock runtime doesn't execute real commands, but the constructor
    // path is exercised)
    const knox = new Knox({
      ...engineOpts(runtime, { task: "Default test" }),
      // No sourceProvider or resultSink — uses defaults
    });

    // We can't fully run this without real git, but we can verify
    // the constructor doesn't throw
    assert(knox !== undefined);
  });
});
