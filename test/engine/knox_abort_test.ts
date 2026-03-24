import { assert, assertEquals } from "@std/assert";
import { Knox } from "../../src/engine/knox.ts";
import type { KnoxEngineOptions } from "../../src/engine/knox.ts";
import { MockRuntime } from "../runtime/mock_runtime.ts";
import type { SourceProvider } from "../../src/engine/source/source_provider.ts";
import { SourceStrategy } from "../../src/engine/source/source_provider.ts";
import type { PrepareResult } from "../../src/engine/source/source_provider.ts";
import type { ResultSink, SinkResult } from "../../src/engine/sink/result_sink.ts";
import { SinkStrategy } from "../../src/engine/sink/result_sink.ts";
import type { KnoxEvent } from "../../src/shared/types.ts";

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

class MockSink implements ResultSink {
  collect(): Promise<SinkResult> {
    return Promise.resolve({
      strategy: SinkStrategy.HostGit,
      branchName: "knox/test",
      commitCount: 1,
      autoCommitted: false,
    });
  }

  cleanup(): Promise<void> {
    return Promise.resolve();
  }
}

function makeRuntime(): MockRuntime {
  const runtime = new MockRuntime();
  // Container session creation: chown, git rev-parse, exclude printf
  runtime.execResults = [
    { exitCode: 0, stdout: "", stderr: "" }, // chown
    { exitCode: 0, stdout: ".git", stderr: "" }, // git rev-parse
    { exitCode: 0, stdout: "", stderr: "" }, // exclude printf
  ];
  return runtime;
}

function makeOptions(
  runtime: MockRuntime,
  signal?: AbortSignal,
): KnoxEngineOptions {
  return {
    task: "test task",
    dir: "/tmp/test-dir",
    image: "knox-agent:latest",
    envVars: ["ANTHROPIC_API_KEY=test"],
    allowedIPs: ["1.2.3.4"],
    maxLoops: 3,
    model: "sonnet",
    signal,
    runtime,
    sourceProvider: new MockSourceProvider(),
    resultSink: new MockSink(),
  };
}

Deno.test("Engine abort: aborting mid-agent-loop returns abort result", async () => {
  const runtime = makeRuntime();

  // The agent loop will call execStream for claude — make it hang for a bit
  // We'll abort during the agent exec
  const controller = new AbortController();
  const events: KnoxEvent[] = [];

  // Override execStream to abort during execution
  runtime.execStream = (
    _container,
    _command,
    _options,
  ) => {
    // Simulate: abort fires during agent execution
    controller.abort();
    return Promise.reject(new Error("command killed"));
  };

  const knox = new Knox({
    ...makeOptions(runtime, controller.signal),
    onEvent: (event) => events.push(event),
  });

  const outcome = await knox.run();

  // Should return ok: true with aborted: true
  assert(outcome.ok, "outcome should be ok");
  if (outcome.ok) {
    assertEquals(outcome.result.aborted, true);
    assertEquals(outcome.result.completed, false);
  }

  // Should have emitted an aborted event
  const abortedEvent = events.find((e) => e.type === "aborted");
  assert(abortedEvent, "should have emitted an 'aborted' event");
});

Deno.test("Engine abort: dispose is triggered by abort signal", async () => {
  const runtime = makeRuntime();
  const controller = new AbortController();

  // Track remove (dispose) calls
  const removeCalls: string[] = [];
  const origRemove = runtime.remove.bind(runtime);
  runtime.remove = (container) => {
    removeCalls.push(container);
    return origRemove(container);
  };

  // Override execStream to abort mid-execution
  runtime.execStream = (
    _container,
    _command,
    _options,
  ) => {
    // Abort — this triggers the abort listener which calls session.dispose()
    controller.abort();
    return Promise.reject(new Error("command killed"));
  };

  const knox = new Knox(makeOptions(runtime, controller.signal));
  await knox.run();

  // dispose() calls runtime.remove() — it should be called
  // (once from abort listener, once from finally — but dispose is idempotent)
  assert(removeCalls.length >= 1, "dispose should have been called at least once");
});

Deno.test("Engine abort: pre-container abort returns abort result", async () => {
  const runtime = makeRuntime();
  const controller = new AbortController();

  // Abort before engine even starts
  controller.abort();

  const knox = new Knox(makeOptions(runtime, controller.signal));
  const outcome = await knox.run();

  assert(outcome.ok, "outcome should be ok");
  if (outcome.ok) {
    assertEquals(outcome.result.aborted, true);
  }

  // No container should have been created
  assertEquals(runtime.callsTo("createContainer").length, 0);
});
