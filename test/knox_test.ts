import { assert, assertEquals } from "@std/assert";
import { MockRuntime } from "./runtime/mock_runtime.ts";
import { Knox } from "../src/knox.ts";
import type { SourceProvider } from "../src/source/source_provider.ts";
import { SourceStrategy } from "../src/source/source_provider.ts";
import type { PrepareResult } from "../src/source/source_provider.ts";
import type { ResultSink, SinkResult } from "../src/sink/result_sink.ts";
import type { CollectOptions } from "../src/sink/result_sink.ts";
import { SinkStrategy } from "../src/sink/result_sink.ts";

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

Deno.test("Knox orchestrator", async (t) => {
  await t.step("wires source and sink in correct order", async () => {
    const runtime = setupMockRuntime();
    const source = new MockSourceProvider();
    const sink = new MockResultSink();

    const origKey = Deno.env.get("ANTHROPIC_API_KEY");
    Deno.env.set("ANTHROPIC_API_KEY", "test-key");

    try {
      const knox = new Knox({
        task: "Test task",
        dir: Deno.cwd(),
        maxLoops: 1,
        model: "sonnet",
        runtime,
        skipPreflight: true,
        onLine: () => {},
        sourceProvider: source,
        resultSink: sink,
      });

      const result = await knox.run();

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
    } finally {
      if (origKey) Deno.env.set("ANTHROPIC_API_KEY", origKey);
      else Deno.env.delete("ANTHROPIC_API_KEY");
    }
  });

  await t.step("run ID propagates to source, sink, and container", async () => {
    const runtime = setupMockRuntime();
    const source = new MockSourceProvider();
    const sink = new MockResultSink();

    const origKey = Deno.env.get("ANTHROPIC_API_KEY");
    Deno.env.set("ANTHROPIC_API_KEY", "test-key");

    try {
      const knox = new Knox({
        task: "Test task",
        dir: Deno.cwd(),
        maxLoops: 1,
        model: "sonnet",
        runtime,
        skipPreflight: true,
        onLine: () => {},
        sourceProvider: source,
        resultSink: sink,
      });

      await knox.run();

      // Source and sink received the same run ID
      const runId = source.lastRunId;
      assert(runId.length === 8, "runId should be 8 hex chars");
      assertEquals(sink.lastOptions!.runId, runId);

      // Container name includes runId
      const createCall = runtime.callsTo("createContainer")[0];
      const createOpts = createCall.args[0] as { name: string };
      assertEquals(createOpts.name, `knox-${runId}`);
    } finally {
      if (origKey) Deno.env.set("ANTHROPIC_API_KEY", origKey);
      else Deno.env.delete("ANTHROPIC_API_KEY");
    }
  });

  await t.step("KnoxResult includes timing metadata", async () => {
    const runtime = setupMockRuntime();
    const source = new MockSourceProvider();
    const sink = new MockResultSink();

    const origKey = Deno.env.get("ANTHROPIC_API_KEY");
    Deno.env.set("ANTHROPIC_API_KEY", "test-key");

    try {
      const before = new Date().toISOString();
      const knox = new Knox({
        task: "Timing test",
        dir: Deno.cwd(),
        maxLoops: 1,
        model: "sonnet",
        runtime,
        skipPreflight: true,
        onLine: () => {},
        sourceProvider: source,
        resultSink: sink,
      });

      const result = await knox.run();
      const after = new Date().toISOString();

      assert(result.startedAt >= before);
      assert(result.finishedAt <= after);
      assert(result.durationMs >= 0);
    } finally {
      if (origKey) Deno.env.set("ANTHROPIC_API_KEY", origKey);
      else Deno.env.delete("ANTHROPIC_API_KEY");
    }
  });

  await t.step("checkPassed is true when completed with check", async () => {
    const runtime = setupMockRuntime();
    const source = new MockSourceProvider();
    const sink = new MockResultSink();

    const origKey = Deno.env.get("ANTHROPIC_API_KEY");
    Deno.env.set("ANTHROPIC_API_KEY", "test-key");

    try {
      const knox = new Knox({
        task: "Check test",
        dir: Deno.cwd(),
        maxLoops: 1,
        model: "sonnet",
        check: "echo ok",
        runtime,
        skipPreflight: true,
        onLine: () => {},
        sourceProvider: source,
        resultSink: sink,
      });

      const result = await knox.run();
      assertEquals(result.checkPassed, true);
    } finally {
      if (origKey) Deno.env.set("ANTHROPIC_API_KEY", origKey);
      else Deno.env.delete("ANTHROPIC_API_KEY");
    }
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

    const origKey = Deno.env.get("ANTHROPIC_API_KEY");
    Deno.env.set("ANTHROPIC_API_KEY", "test-key");

    try {
      const knox = new Knox({
        task: "Nudge test",
        dir: Deno.cwd(),
        maxLoops: 1,
        model: "sonnet",
        runtime,
        skipPreflight: true,
        onLine: () => {},
        sourceProvider: source,
        resultSink: sink,
      });

      const result = await knox.run();

      // Nudge should have triggered an execStream call with the nudge prompt
      const streamCalls = runtime.callsTo("execStream");
      assertEquals(streamCalls.length, 2); // 1 loop + 1 nudge
      assertEquals(result.autoCommitted, false); // nudge succeeded
    } finally {
      if (origKey) Deno.env.set("ANTHROPIC_API_KEY", origKey);
      else Deno.env.delete("ANTHROPIC_API_KEY");
    }
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

      const origKey = Deno.env.get("ANTHROPIC_API_KEY");
      Deno.env.set("ANTHROPIC_API_KEY", "test-key");

      try {
        const knox = new Knox({
          task: "Auto-commit test",
          dir: Deno.cwd(),
          maxLoops: 1,
          model: "sonnet",
          runtime,
          skipPreflight: true,
          onLine: () => {},
          sourceProvider: source,
          resultSink: sink,
        });

        const result = await knox.run();
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
      } finally {
        if (origKey) Deno.env.set("ANTHROPIC_API_KEY", origKey);
        else Deno.env.delete("ANTHROPIC_API_KEY");
      }
    },
  );

  await t.step("defaults to GitSourceProvider and GitBranchSink", () => {
    const runtime = setupMockRuntime();

    const origKey = Deno.env.get("ANTHROPIC_API_KEY");
    Deno.env.set("ANTHROPIC_API_KEY", "test-key");

    try {
      // This verifies no crash when using defaults (won't actually clone/fetch
      // because mock runtime doesn't execute real commands, but the constructor
      // path is exercised)
      const knox = new Knox({
        task: "Default test",
        dir: Deno.cwd(),
        maxLoops: 1,
        model: "sonnet",
        runtime,
        skipPreflight: true,
        onLine: () => {},
        // No sourceProvider or resultSink — uses defaults
      });

      // We can't fully run this without real git, but we can verify
      // the constructor doesn't throw
      assert(knox !== undefined);
    } finally {
      if (origKey) Deno.env.set("ANTHROPIC_API_KEY", origKey);
      else Deno.env.delete("ANTHROPIC_API_KEY");
    }
  });
});
