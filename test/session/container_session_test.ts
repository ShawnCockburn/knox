import { assert, assertEquals, assertRejects } from "@std/assert";
import { MockRuntime } from "../runtime/mock_runtime.ts";
import { ContainerSession } from "../../src/session/container_session.ts";
import type { SourceProvider } from "../../src/source/source_provider.ts";
import { SourceStrategy } from "../../src/source/source_provider.ts";
import type { PrepareResult } from "../../src/source/source_provider.ts";

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

function createOptions(runtime: MockRuntime, source?: MockSourceProvider) {
  return {
    runtime,
    runId: "test1234",
    runDir: "/tmp/knox-test1234",
    image: "knox-agent:latest",
    envVars: ["ANTHROPIC_API_KEY=test-key"],
    allowedIPs: ["1.2.3.4"],
    sourceProvider: source ?? new MockSourceProvider(),
    cpuLimit: undefined,
    memoryLimit: undefined,
  };
}

Deno.test("ContainerSession", async (t) => {
  await t.step(
    "create() calls source prepare, createContainer, copyIn, chown, restrictNetwork, git verify, excludes",
    async () => {
      const runtime = new MockRuntime();
      // All exec calls return success (chown, git check, exclude setup)
      runtime.execResults = [
        { exitCode: 0, stdout: "", stderr: "" }, // chown
        { exitCode: 0, stdout: ".git", stderr: "" }, // git rev-parse
        { exitCode: 0, stdout: "", stderr: "" }, // exclude printf
      ];
      const source = new MockSourceProvider();

      const session = await ContainerSession.create(
        createOptions(runtime, source),
      );

      // Source was prepared and cleaned up
      assertEquals(source.prepareCalled, true);
      assertEquals(source.cleanupCalled, true);
      assertEquals(source.lastRunId, "test1234");

      // Verify call sequence
      const methods = runtime.calls.map((c) => c.method);
      assertEquals(methods, [
        "createContainer",
        "copyIn",
        "exec", // chown
        "restrictNetwork",
        "exec", // git rev-parse --git-dir
        "exec", // exclude printf
      ]);

      // Container was created with correct options
      const createCall = runtime.callsTo("createContainer")[0];
      const opts = createCall.args[0] as {
        name: string;
        workdir: string;
        capAdd: string[];
      };
      assertEquals(opts.name, "knox-test1234");
      assertEquals(opts.workdir, "/workspace");
      assertEquals(opts.capAdd, ["NET_ADMIN"]);

      // copyIn used the source hostPath
      const copyCall = runtime.callsTo("copyIn")[0];
      assertEquals(copyCall.args[1], "/tmp/mock-source/.");
      assertEquals(copyCall.args[2], "/workspace");

      // Session exposes containerId and metadata
      assertEquals(session.containerId, "mock-container-1");
      assertEquals(session.metadata.baseCommit, "abc123");

      await session.dispose();
    },
  );

  await t.step("create() throws when git verification fails", async () => {
    const runtime = new MockRuntime();
    runtime.execResults = [
      { exitCode: 0, stdout: "", stderr: "" }, // chown
      { exitCode: 1, stdout: "", stderr: "not a git repo" }, // git rev-parse FAILS
    ];

    await assertRejects(
      () => ContainerSession.create(createOptions(runtime)),
      Error,
      "No .git directory",
    );

    // Container should have been cleaned up
    const removeCalls = runtime.callsTo("remove");
    assertEquals(removeCalls.length, 1);
  });

  await t.step("dispose() removes container", async () => {
    const runtime = new MockRuntime();
    runtime.execResults = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: ".git", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];

    const session = await ContainerSession.create(createOptions(runtime));
    runtime.calls = []; // reset to track only dispose calls

    await session.dispose();

    const removeCalls = runtime.callsTo("remove");
    assertEquals(removeCalls.length, 1);
    assertEquals(removeCalls[0].args[0], "mock-container-1");
  });

  await t.step("dispose() is idempotent", async () => {
    const runtime = new MockRuntime();
    runtime.execResults = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: ".git", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];

    const session = await ContainerSession.create(createOptions(runtime));
    runtime.calls = [];

    await session.dispose();
    await session.dispose();

    // remove should only be called once
    const removeCalls = runtime.callsTo("remove");
    assertEquals(removeCalls.length, 1);
  });

  await t.step(
    "source provider prepare() and cleanup() are called by create()",
    async () => {
      const runtime = new MockRuntime();
      runtime.execResults = [
        { exitCode: 0, stdout: "", stderr: "" },
        { exitCode: 0, stdout: ".git", stderr: "" },
        { exitCode: 0, stdout: "", stderr: "" },
      ];
      const source = new MockSourceProvider();

      const session = await ContainerSession.create(
        createOptions(runtime, source),
      );

      assertEquals(source.prepareCalled, true);
      assertEquals(source.cleanupCalled, true);

      await session.dispose();
    },
  );

  await t.step("hasDirtyTree() returns true when workspace is dirty", async () => {
    const runtime = new MockRuntime();
    runtime.execResults = [
      { exitCode: 0, stdout: "", stderr: "" }, // chown
      { exitCode: 0, stdout: ".git", stderr: "" }, // git rev-parse
      { exitCode: 0, stdout: "", stderr: "" }, // exclude printf
    ];
    const session = await ContainerSession.create(createOptions(runtime));

    // Override exec to return dirty status
    runtime.exec = (container, command, options) => {
      runtime.calls.push({ method: "exec", args: [container, command, options] });
      return Promise.resolve({ exitCode: 0, stdout: " M dirty.ts\n", stderr: "" });
    };
    const dirty = await session.hasDirtyTree();
    assertEquals(dirty, true);

    await session.dispose();
  });

  await t.step("hasDirtyTree() returns false when workspace is clean", async () => {
    const runtime = new MockRuntime();
    runtime.execResults = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: ".git", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    const session = await ContainerSession.create(createOptions(runtime));

    runtime.exec = (container, command, options) => {
      runtime.calls.push({ method: "exec", args: [container, command, options] });
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };
    const dirty = await session.hasDirtyTree();
    assertEquals(dirty, false);

    await session.dispose();
  });

  await t.step("extractBundle() creates bundle and copies to host", async () => {
    const runtime = new MockRuntime();
    runtime.execResults = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: ".git", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    const session = await ContainerSession.create(createOptions(runtime));
    runtime.calls = [];

    runtime.exec = (container, command, options) => {
      runtime.calls.push({ method: "exec", args: [container, command, options] });
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };
    const bundlePath = await session.extractBundle();

    assertEquals(bundlePath, "/tmp/knox-test1234/bundle.git");

    // Verify exec was called with git bundle create
    const execCalls = runtime.callsTo("exec");
    assertEquals(execCalls.length, 1);
    const cmd = execCalls[0].args[1] as string[];
    assertEquals(cmd[0], "git");
    assertEquals(cmd[1], "bundle");
    assertEquals(cmd[2], "create");

    // Verify copyOut was called
    const copyCalls = runtime.callsTo("copyOut");
    assertEquals(copyCalls.length, 1);
    assertEquals(copyCalls[0].args[1], "/tmp/knox.bundle");
    assertEquals(copyCalls[0].args[2], "/tmp/knox-test1234/bundle.git");

    await session.dispose();
  });

  await t.step("extractBundle() throws on git bundle failure", async () => {
    const runtime = new MockRuntime();
    runtime.execResults = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: ".git", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    const session = await ContainerSession.create(createOptions(runtime));

    runtime.exec = (container, command, options) => {
      runtime.calls.push({ method: "exec", args: [container, command, options] });
      return Promise.resolve({ exitCode: 1, stdout: "", stderr: "bundle error" });
    };

    await assertRejects(
      () => session.extractBundle(),
      Error,
      "git bundle create failed",
    );

    await session.dispose();
  });
});
