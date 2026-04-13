import { assert, assertEquals } from "@std/assert";
import { BranchQueueOutput } from "../../src/queue/output/branch_queue_output.ts";
import type {
  QueueOutput,
  QueueOutputResult,
} from "../../src/queue/output/queue_output.ts";
import { Orchestrator } from "../../src/queue/orchestrator.ts";
import type { QueueReport } from "../../src/queue/orchestrator.ts";
import type { KnoxEngineOptions, KnoxOutcome } from "../../src/engine/knox.ts";
import { SinkStrategy } from "../../src/engine/sink/result_sink.ts";
import type {
  ItemState,
  LoadResult,
  QueueManifest,
  QueueSource,
  QueueState,
} from "../../src/queue/types.ts";
import { createFakeExecutionContext } from "../fake_execution.ts";

// --- Helpers ---

class MockQueueSource implements QueueSource {
  private loadResult: LoadResult;
  state: QueueState | null = null;
  updates: Array<{ itemId: string; state: Partial<ItemState> }> = [];

  constructor(manifest: QueueManifest) {
    this.loadResult = { ok: true, manifest };
  }

  load(): Promise<LoadResult> {
    return Promise.resolve(this.loadResult);
  }

  update(itemId: string, state: Partial<ItemState>): Promise<void> {
    this.updates.push({ itemId, state: { ...state } });
    return Promise.resolve();
  }

  writeState(s: QueueState): Promise<void> {
    this.state = structuredClone(s);
    return Promise.resolve();
  }

  readState(): Promise<QueueState | null> {
    return Promise.resolve(this.state);
  }
}

function mockEngineFactory() {
  return (opts: KnoxEngineOptions) => ({
    run(): Promise<KnoxOutcome> {
      return Promise.resolve({
        ok: true,
        result: {
          runId: opts.runId!,
          completed: true,
          aborted: false,
          loopsRun: 1,
          maxLoops: opts.maxLoops ?? 10,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 10,
          provider: "claude",
          difficulty: opts.difficulty ?? "balanced",
          model: opts.model ?? "sonnet",
          task: opts.task,
          autoCommitted: false,
          checkPassed: null,
          sink: {
            strategy: SinkStrategy.HostGit,
            branchName: `knox/test-${opts.runId}`,
            commitCount: 1,
            autoCommitted: false,
          },
        },
      });
    },
  });
}

const defaultExecution = createFakeExecutionContext();

async function setupLogDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "knox-queue-output-test-" });
}

async function cleanup(dir: string) {
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

// --- Tests ---

Deno.test("BranchQueueOutput", async (t) => {
  await t.step("deliver() returns empty result", async () => {
    const output = new BranchQueueOutput();
    const manifest: QueueManifest = { items: [{ id: "a", task: "Task A" }] };
    // Build a minimal report to pass in
    const report = {
      queueRunId: "test",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      items: [],
      manifest,
    } as QueueReport;

    const result = await output.deliver(report, manifest);
    assertEquals(result, {});
    assertEquals(result.prs, undefined);
  });
});

Deno.test("Orchestrator + queueOutput", async (t) => {
  await t.step("calls queueOutput.deliver() after run completes", async () => {
    const logDir = await setupLogDir();
    try {
      const deliverCalls: Array<
        { report: QueueReport; manifest: QueueManifest }
      > = [];

      const mockOutput: QueueOutput = {
        deliver(
          report: QueueReport,
          manifest: QueueManifest,
        ): Promise<QueueOutputResult> {
          deliverCalls.push({ report, manifest });
          return Promise.resolve({});
        },
      };

      const source = new MockQueueSource({
        items: [
          { id: "a", task: "Task A" },
          { id: "b", task: "Task B" },
        ],
      });

      const orchestrator = new Orchestrator({
        source,
        execution: defaultExecution,
        image: "knox-agent:latest",
        dir: Deno.cwd(),
        logDir,
        engineFactory: mockEngineFactory(),
        queueOutput: mockOutput,
      });

      const report = await orchestrator.run();

      // deliver was called once
      assertEquals(deliverCalls.length, 1);

      // Called with the completed report (all items done)
      const call = deliverCalls[0];
      assertEquals(call.report.items.length, 2);
      assertEquals(call.report.items[0].status, "completed");
      assertEquals(call.report.items[1].status, "completed");

      // Called with the manifest
      assertEquals(call.manifest.items.length, 2);

      // Report is the same object returned
      assertEquals(report.queueRunId, call.report.queueRunId);
    } finally {
      await cleanup(logDir);
    }
  });

  await t.step(
    "works without queueOutput option (backwards compatible)",
    async () => {
      const logDir = await setupLogDir();
      try {
        const source = new MockQueueSource({
          items: [{ id: "a", task: "Task A" }],
        });

        const orchestrator = new Orchestrator({
          source,
          execution: defaultExecution,
          image: "knox-agent:latest",
          dir: Deno.cwd(),
          logDir,
          engineFactory: mockEngineFactory(),
          // No queueOutput
        });

        const report = await orchestrator.run();

        // Should work fine without queueOutput
        assertEquals(report.items.length, 1);
        assertEquals(report.items[0].status, "completed");
        assertEquals(report.outputResult, undefined);
      } finally {
        await cleanup(logDir);
      }
    },
  );

  await t.step(
    "QueueOutputResult is included in the report when present",
    async () => {
      const logDir = await setupLogDir();
      try {
        const mockOutput: QueueOutput = {
          deliver(): Promise<QueueOutputResult> {
            return Promise.resolve({
              prs: [
                {
                  itemId: "a",
                  url: "https://github.com/org/repo/pull/42",
                  number: 42,
                  draft: false,
                },
              ],
            });
          },
        };

        const source = new MockQueueSource({
          items: [{ id: "a", task: "Task A" }],
        });

        const orchestrator = new Orchestrator({
          source,
          execution: defaultExecution,
          image: "knox-agent:latest",
          dir: Deno.cwd(),
          logDir,
          engineFactory: mockEngineFactory(),
          queueOutput: mockOutput,
        });

        const report = await orchestrator.run();

        // outputResult attached to report
        assert(report.outputResult !== undefined);
        assertEquals(report.outputResult.prs?.length, 1);
        assertEquals(report.outputResult.prs?.[0].itemId, "a");
        assertEquals(report.outputResult.prs?.[0].number, 42);

        // Verify JSON roundtrip includes outputResult
        const json = JSON.parse(JSON.stringify(report));
        assert(json.outputResult);
        assertEquals(json.outputResult.prs.length, 1);
        assertEquals(json.outputResult.prs[0].itemId, "a");
      } finally {
        await cleanup(logDir);
      }
    },
  );

  await t.step("manifest is included in the report", async () => {
    const logDir = await setupLogDir();
    try {
      const manifest: QueueManifest = {
        items: [
          { id: "a", task: "Task A", group: "feat" },
          { id: "b", task: "Task B", dependsOn: ["a"] },
        ],
        concurrency: 2,
      };

      const source = new MockQueueSource(manifest);

      const orchestrator = new Orchestrator({
        source,
        execution: defaultExecution,
        image: "knox-agent:latest",
        dir: Deno.cwd(),
        logDir,
        engineFactory: mockEngineFactory(),
      });

      const report = await orchestrator.run();

      // manifest is accessible on the report
      assertEquals(report.manifest.items.length, 2);
      assertEquals(report.manifest.items[0].id, "a");
      assertEquals(report.manifest.items[0].group, "feat");
      assertEquals(report.manifest.items[1].dependsOn, ["a"]);
      assertEquals(report.manifest.concurrency, 2);
    } finally {
      await cleanup(logDir);
    }
  });
});
