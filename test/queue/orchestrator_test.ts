import { assert, assertEquals } from "@std/assert";
import {
  Orchestrator,
  OrchestratorValidationError,
} from "../../src/queue/orchestrator.ts";
import type { KnoxEngineOptions, KnoxOutcome } from "../../src/engine/knox.ts";
import { SinkStrategy } from "../../src/engine/sink/result_sink.ts";
import type { KnoxEvent } from "../../src/shared/types.ts";
import type {
  ItemState,
  LoadResult,
  QueueManifest,
  QueueSource,
  QueueState,
} from "../../src/queue/types.ts";

/** Mock engine that returns configurable outcomes per item. */
function mockEngineFactory(
  outcomes: Map<string, KnoxOutcome>,
  calls: KnoxEngineOptions[] = [],
) {
  return (opts: KnoxEngineOptions) => {
    calls.push(opts);
    const taskKey = opts.task;
    return {
      run(): Promise<KnoxOutcome> {
        const outcome = outcomes.get(taskKey);
        if (!outcome) {
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
              durationMs: 100,
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
        }
        return Promise.resolve(outcome);
      },
    };
  };
}

/** Mock QueueSource backed by an in-memory manifest. */
class MockQueueSource implements QueueSource {
  private loadResult: LoadResult;
  state: QueueState | null = null;
  updates: Array<{ itemId: string; state: Partial<ItemState> }> = [];

  constructor(manifest: QueueManifest) {
    this.loadResult = { ok: true, manifest };
  }

  static invalid(errors: Array<{ message: string }>): MockQueueSource {
    const source = new MockQueueSource({ items: [] });
    source.loadResult = { ok: false, errors };
    return source;
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

async function setupLogDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "knox-queue-test-logs-" });
}

async function cleanup(dir: string) {
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

Deno.test("Orchestrator", async (t) => {
  await t.step("runs items serially and produces report", async () => {
    const logDir = await setupLogDir();
    try {
      const source = new MockQueueSource({
        items: [
          { id: "a", task: "Task A" },
          { id: "b", task: "Task B" },
        ],
      });

      const engineCalls: KnoxEngineOptions[] = [];
      const orchestrator = new Orchestrator({
        source,
        image: "knox-agent:latest",
        envVars: ["ANTHROPIC_API_KEY=test"],
        allowedIPs: ["1.2.3.4"],
        dir: Deno.cwd(),
        logDir,
        engineFactory: mockEngineFactory(new Map(), engineCalls),
      });

      const report = await orchestrator.run();

      // Both items completed
      assertEquals(report.items.length, 2);
      assertEquals(report.items[0].status, "completed");
      assertEquals(report.items[1].status, "completed");

      // Engine was called twice
      assertEquals(engineCalls.length, 2);
      assertEquals(engineCalls[0].task, "Task A");
      assertEquals(engineCalls[1].task, "Task B");

      // Report has timing
      assert(report.queueRunId.length === 8);
      assert(report.durationMs >= 0);
    } finally {
      await cleanup(logDir);
    }
  });

  await t.step("state file updated on every transition", async () => {
    const logDir = await setupLogDir();
    try {
      const source = new MockQueueSource({
        items: [
          { id: "a", task: "Task A" },
        ],
      });

      const orchestrator = new Orchestrator({
        source,
        image: "knox-agent:latest",
        envVars: [],
        allowedIPs: [],
        dir: Deno.cwd(),
        logDir,
        engineFactory: mockEngineFactory(new Map()),
      });

      await orchestrator.run();

      // Should have updates: in_progress and completed
      const aUpdates = source.updates.filter((u) => u.itemId === "a");
      assertEquals(aUpdates.length, 2);
      assertEquals(aUpdates[0].state.status, "in_progress");
      assertEquals(aUpdates[1].state.status, "completed");
    } finally {
      await cleanup(logDir);
    }
  });

  await t.step("failed item does not crash orchestrator", async () => {
    const logDir = await setupLogDir();
    try {
      const outcomes = new Map<string, KnoxOutcome>([
        ["Task A", {
          ok: false,
          error: "Container crashed",
          phase: "container",
        }],
      ]);

      const source = new MockQueueSource({
        items: [
          { id: "a", task: "Task A" },
          { id: "b", task: "Task B" },
        ],
      });

      const orchestrator = new Orchestrator({
        source,
        image: "knox-agent:latest",
        envVars: [],
        allowedIPs: [],
        dir: Deno.cwd(),
        logDir,
        engineFactory: mockEngineFactory(outcomes),
      });

      const report = await orchestrator.run();

      // A failed, B still ran
      assertEquals(report.items[0].status, "failed");
      assertEquals(report.items[1].status, "completed");
    } finally {
      await cleanup(logDir);
    }
  });

  await t.step("per-item log files written", async () => {
    const logDir = await setupLogDir();
    try {
      const source = new MockQueueSource({
        items: [
          { id: "a", task: "Task A" },
        ],
      });

      const orchestrator = new Orchestrator({
        source,
        image: "knox-agent:latest",
        envVars: [],
        allowedIPs: [],
        dir: Deno.cwd(),
        logDir,
        engineFactory: mockEngineFactory(new Map()),
      });

      await orchestrator.run();

      // Log file should exist (may be empty since mock engine doesn't call onLine)
      const stat = await Deno.stat(`${logDir}/a.log`);
      assert(stat.isFile);
    } finally {
      await cleanup(logDir);
    }
  });

  await t.step("merges defaults with item overrides", async () => {
    const logDir = await setupLogDir();
    try {
      const source = new MockQueueSource({
        defaults: { model: "opus", maxLoops: 5, env: ["DEFAULT=true"] },
        items: [
          { id: "a", task: "Task A", model: "haiku", env: ["ITEM=yes"] },
          { id: "b", task: "Task B" },
        ],
      });

      const engineCalls: KnoxEngineOptions[] = [];
      const orchestrator = new Orchestrator({
        source,
        image: "knox-agent:latest",
        envVars: ["GLOBAL=true"],
        allowedIPs: [],
        dir: Deno.cwd(),
        logDir,
        engineFactory: mockEngineFactory(new Map(), engineCalls),
      });

      await orchestrator.run();

      // Item A: model overridden, env merged
      assertEquals(engineCalls[0].model, "haiku");
      assertEquals(engineCalls[0].maxLoops, 5); // from defaults
      assert(engineCalls[0].envVars.includes("GLOBAL=true"));
      assert(engineCalls[0].envVars.includes("DEFAULT=true"));
      assert(engineCalls[0].envVars.includes("ITEM=yes"));

      // Item B: uses defaults
      assertEquals(engineCalls[1].model, "opus");
      assertEquals(engineCalls[1].maxLoops, 5);
    } finally {
      await cleanup(logDir);
    }
  });

  await t.step(
    "validation error throws OrchestratorValidationError",
    async () => {
      const logDir = await setupLogDir();
      try {
        const source = MockQueueSource.invalid([
          { message: "Missing id" },
        ]);

        const orchestrator = new Orchestrator({
          source,
          image: "knox-agent:latest",
          envVars: [],
          allowedIPs: [],
          dir: Deno.cwd(),
          logDir,
          engineFactory: mockEngineFactory(new Map()),
        });

        let caught = false;
        try {
          await orchestrator.run();
        } catch (e) {
          caught = true;
          assert(e instanceof OrchestratorValidationError);
          assertEquals(e.errors.length, 1);
        }
        assert(caught, "Expected OrchestratorValidationError");
      } finally {
        await cleanup(logDir);
      }
    },
  );

  await t.step("final JSON report is complete", async () => {
    const logDir = await setupLogDir();
    try {
      const source = new MockQueueSource({
        items: [
          { id: "a", task: "Task A" },
        ],
      });

      const orchestrator = new Orchestrator({
        source,
        image: "knox-agent:latest",
        envVars: [],
        allowedIPs: [],
        dir: Deno.cwd(),
        logDir,
        engineFactory: mockEngineFactory(new Map()),
      });

      const report = await orchestrator.run();

      // Verify JSON roundtrip
      const json = JSON.parse(JSON.stringify(report));
      assert(json.queueRunId);
      assert(json.startedAt);
      assert(json.finishedAt);
      assert(json.durationMs >= 0);
      assertEquals(json.items.length, 1);
      assertEquals(json.items[0].id, "a");
      assertEquals(json.items[0].status, "completed");
    } finally {
      await cleanup(logDir);
    }
  });

  // --- Phase 3: DAG scheduling ---

  await t.step("items with dependencies run after deps complete", async () => {
    const logDir = await setupLogDir();
    try {
      const source = new MockQueueSource({
        items: [
          { id: "a", task: "Task A" },
          { id: "b", task: "Task B", dependsOn: ["a"] },
          { id: "c", task: "Task C", dependsOn: ["b"] },
        ],
      });

      const engineCalls: KnoxEngineOptions[] = [];
      const orchestrator = new Orchestrator({
        source,
        image: "knox-agent:latest",
        envVars: [],
        allowedIPs: [],
        dir: Deno.cwd(),
        logDir,
        engineFactory: mockEngineFactory(new Map(), engineCalls),
      });

      const report = await orchestrator.run();

      // All completed in order
      assertEquals(report.items[0].status, "completed");
      assertEquals(report.items[1].status, "completed");
      assertEquals(report.items[2].status, "completed");
      assertEquals(engineCalls[0].task, "Task A");
      assertEquals(engineCalls[1].task, "Task B");
      assertEquals(engineCalls[2].task, "Task C");
    } finally {
      await cleanup(logDir);
    }
  });

  await t.step("failed item blocks transitive dependents", async () => {
    const logDir = await setupLogDir();
    try {
      const outcomes = new Map<string, KnoxOutcome>([
        ["Task A", {
          ok: false,
          error: "Failed",
          phase: "agent",
        }],
      ]);

      const source = new MockQueueSource({
        items: [
          { id: "a", task: "Task A" },
          { id: "b", task: "Task B", dependsOn: ["a"] },
          { id: "c", task: "Task C", dependsOn: ["b"] },
        ],
      });

      const orchestrator = new Orchestrator({
        source,
        image: "knox-agent:latest",
        envVars: [],
        allowedIPs: [],
        dir: Deno.cwd(),
        logDir,
        engineFactory: mockEngineFactory(outcomes),
      });

      const report = await orchestrator.run();

      assertEquals(report.items[0].status, "failed");
      assertEquals(report.items[1].status, "blocked");
      assertEquals(report.items[1].blockedBy, "a");
      assertEquals(report.items[2].status, "blocked");
      assertEquals(report.items[2].blockedBy, "b");
    } finally {
      await cleanup(logDir);
    }
  });

  await t.step("diamond DAG: B fails, D blocked, C continues", async () => {
    const logDir = await setupLogDir();
    try {
      const outcomes = new Map<string, KnoxOutcome>([
        ["Task B", {
          ok: false,
          error: "Failed",
          phase: "agent",
        }],
      ]);

      const source = new MockQueueSource({
        items: [
          { id: "a", task: "Task A" },
          { id: "b", task: "Task B", dependsOn: ["a"] },
          { id: "c", task: "Task C", dependsOn: ["a"] },
          { id: "d", task: "Task D", dependsOn: ["b", "c"] },
        ],
      });

      const orchestrator = new Orchestrator({
        source,
        image: "knox-agent:latest",
        envVars: [],
        allowedIPs: [],
        dir: Deno.cwd(),
        logDir,
        engineFactory: mockEngineFactory(outcomes),
      });

      const report = await orchestrator.run();

      assertEquals(report.items[0].status, "completed"); // a
      assertEquals(report.items[1].status, "failed"); // b
      assertEquals(report.items[2].status, "completed"); // c
      assertEquals(report.items[3].status, "blocked"); // d
      assertEquals(report.items[3].blockedBy, "b");
    } finally {
      await cleanup(logDir);
    }
  });

  await t.step("all independent items run regardless of failures", async () => {
    const logDir = await setupLogDir();
    try {
      const outcomes = new Map<string, KnoxOutcome>([
        ["Task B", {
          ok: false,
          error: "Failed",
          phase: "agent",
        }],
      ]);

      const source = new MockQueueSource({
        items: [
          { id: "a", task: "Task A" },
          { id: "b", task: "Task B" },
          { id: "c", task: "Task C" },
        ],
      });

      const orchestrator = new Orchestrator({
        source,
        image: "knox-agent:latest",
        envVars: [],
        allowedIPs: [],
        dir: Deno.cwd(),
        logDir,
        engineFactory: mockEngineFactory(outcomes),
      });

      const report = await orchestrator.run();

      assertEquals(report.items[0].status, "completed");
      assertEquals(report.items[1].status, "failed");
      assertEquals(report.items[2].status, "completed");
    } finally {
      await cleanup(logDir);
    }
  });

  // --- Phase 4: Concurrency ---

  await t.step("concurrency: N runs items in parallel", async () => {
    const logDir = await setupLogDir();
    try {
      const runningCount = { current: 0, max: 0 };
      const engineFactory = (opts: KnoxEngineOptions) => ({
        async run(): Promise<KnoxOutcome> {
          runningCount.current++;
          if (runningCount.current > runningCount.max) {
            runningCount.max = runningCount.current;
          }
          // Simulate some work
          await new Promise((r) => setTimeout(r, 50));
          runningCount.current--;
          return {
            ok: true,
            result: {
              runId: opts.runId!,
              completed: true,
              aborted: false,
              loopsRun: 1,
              maxLoops: 10,
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              durationMs: 50,
              model: "sonnet",
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
          };
        },
      });

      const source = new MockQueueSource({
        concurrency: 2,
        items: [
          { id: "a", task: "Task A" },
          { id: "b", task: "Task B" },
          { id: "c", task: "Task C" },
        ],
      });

      const orchestrator = new Orchestrator({
        source,
        image: "knox-agent:latest",
        envVars: [],
        allowedIPs: [],
        dir: Deno.cwd(),
        logDir,
        engineFactory,
      });

      const report = await orchestrator.run();

      assertEquals(report.items.every((i) => i.status === "completed"), true);
      // At least 2 items ran concurrently
      assertEquals(runningCount.max, 2);
    } finally {
      await cleanup(logDir);
    }
  });

  await t.step(
    "dependent items respect ordering with concurrency",
    async () => {
      const logDir = await setupLogDir();
      try {
        const order: string[] = [];
        const engineFactory = (opts: KnoxEngineOptions) => ({
          run(): Promise<KnoxOutcome> {
            order.push(opts.task);
            return Promise.resolve({
              ok: true,
              result: {
                runId: opts.runId!,
                completed: true,
                aborted: false,
                loopsRun: 1,
                maxLoops: 10,
                startedAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
                durationMs: 10,
                model: "sonnet",
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

        const source = new MockQueueSource({
          concurrency: 5,
          items: [
            { id: "a", task: "Task A" },
            { id: "b", task: "Task B", dependsOn: ["a"] },
          ],
        });

        const orchestrator = new Orchestrator({
          source,
          image: "knox-agent:latest",
          envVars: [],
          allowedIPs: [],
          dir: Deno.cwd(),
          logDir,
          engineFactory,
        });

        await orchestrator.run();

        // A must run before B
        assertEquals(order.indexOf("Task A") < order.indexOf("Task B"), true);
      } finally {
        await cleanup(logDir);
      }
    },
  );

  // --- Phase 5: Groups + chained execution ---

  await t.step("grouped items share a single branch name", async () => {
    const logDir = await setupLogDir();
    try {
      const engineCalls: KnoxEngineOptions[] = [];
      const engineFactory = (opts: KnoxEngineOptions) => {
        engineCalls.push(opts);
        const branch = opts.branchName ?? `knox/test-${opts.runId}`;
        return {
          run(): Promise<KnoxOutcome> {
            return Promise.resolve({
              ok: true,
              result: {
                runId: opts.runId!,
                completed: true,
                aborted: false,
                loopsRun: 1,
                maxLoops: 10,
                startedAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
                durationMs: 10,
                model: "sonnet",
                task: opts.task,
                autoCommitted: false,
                checkPassed: null,
                sink: {
                  strategy: SinkStrategy.HostGit,
                  branchName: branch,
                  commitCount: 1,
                  autoCommitted: false,
                },
              },
            });
          },
        };
      };

      const source = new MockQueueSource({
        items: [
          { id: "a", task: "Task A", group: "feature" },
          { id: "b", task: "Task B", group: "feature", dependsOn: ["a"] },
          { id: "c", task: "Task C", group: "feature", dependsOn: ["b"] },
        ],
      });

      const orchestrator = new Orchestrator({
        source,
        image: "knox-agent:latest",
        envVars: [],
        allowedIPs: [],
        dir: Deno.cwd(),
        logDir,
        engineFactory,
      });

      const report = await orchestrator.run();

      // All items completed
      assertEquals(report.items.every((i) => i.status === "completed"), true);

      // All items share the same branch
      const branches = report.items.map((i) => i.branch);
      assertEquals(branches[0], branches[1]);
      assertEquals(branches[1], branches[2]);
      assert(branches[0]!.startsWith("knox/feature-"));
    } finally {
      await cleanup(logDir);
    }
  });

  await t.step("ungrouped items produce individual branches", async () => {
    const logDir = await setupLogDir();
    try {
      const source = new MockQueueSource({
        items: [
          { id: "a", task: "Task A" },
          { id: "b", task: "Task B" },
        ],
      });

      const orchestrator = new Orchestrator({
        source,
        image: "knox-agent:latest",
        envVars: [],
        allowedIPs: [],
        dir: Deno.cwd(),
        logDir,
        engineFactory: mockEngineFactory(new Map()),
      });

      const report = await orchestrator.run();

      // Each item has a different branch
      assert(report.items[0].branch !== report.items[1].branch);
    } finally {
      await cleanup(logDir);
    }
  });

  await t.step("mixed grouped and ungrouped items", async () => {
    const logDir = await setupLogDir();
    try {
      const engineCalls: KnoxEngineOptions[] = [];
      const engineFactory = (opts: KnoxEngineOptions) => {
        engineCalls.push(opts);
        const branch = opts.branchName ?? `knox/test-${opts.runId}`;
        return {
          run(): Promise<KnoxOutcome> {
            return Promise.resolve({
              ok: true,
              result: {
                runId: opts.runId!,
                completed: true,
                aborted: false,
                loopsRun: 1,
                maxLoops: 10,
                startedAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
                durationMs: 10,
                model: "sonnet",
                task: opts.task,
                autoCommitted: false,
                checkPassed: null,
                sink: {
                  strategy: SinkStrategy.HostGit,
                  branchName: branch,
                  commitCount: 1,
                  autoCommitted: false,
                },
              },
            });
          },
        };
      };

      const source = new MockQueueSource({
        items: [
          { id: "a", task: "Task A", group: "feat" },
          { id: "b", task: "Task B", group: "feat", dependsOn: ["a"] },
          { id: "c", task: "Task C" }, // ungrouped
        ],
      });

      const orchestrator = new Orchestrator({
        source,
        image: "knox-agent:latest",
        envVars: [],
        allowedIPs: [],
        dir: Deno.cwd(),
        logDir,
        engineFactory,
      });

      const report = await orchestrator.run();

      // Group items share branch
      assertEquals(report.items[0].branch, report.items[1].branch);
      // Ungrouped item has different branch
      assert(report.items[2].branch !== report.items[0].branch);

      // Group branch follows naming convention
      assert(report.items[0].branch!.startsWith("knox/feat-"));
      // Ungrouped branch follows default naming
      assert(report.items[2].branch!.startsWith("knox/test-"));
    } finally {
      await cleanup(logDir);
    }
  });

  await t.step(
    "failed item in group chain blocks subsequent chain items",
    async () => {
      const logDir = await setupLogDir();
      try {
        const outcomes = new Map<string, KnoxOutcome>([
          ["Task B", { ok: false, error: "Failed", phase: "agent" }],
        ]);

        const source = new MockQueueSource({
          items: [
            { id: "a", task: "Task A", group: "feat" },
            { id: "b", task: "Task B", group: "feat", dependsOn: ["a"] },
            { id: "c", task: "Task C", group: "feat", dependsOn: ["b"] },
          ],
        });

        const orchestrator = new Orchestrator({
          source,
          image: "knox-agent:latest",
          envVars: [],
          allowedIPs: [],
          dir: Deno.cwd(),
          logDir,
          engineFactory: mockEngineFactory(outcomes),
        });

        const report = await orchestrator.run();

        assertEquals(report.items[0].status, "completed");
        assertEquals(report.items[1].status, "failed");
        assertEquals(report.items[2].status, "blocked");
        assertEquals(report.items[2].blockedBy, "b");
      } finally {
        await cleanup(logDir);
      }
    },
  );

  // --- Phase 6: Resumability ---

  await t.step("resume skips completed items", async () => {
    const logDir = await setupLogDir();
    try {
      const source = new MockQueueSource({
        items: [
          { id: "a", task: "Task A" },
          { id: "b", task: "Task B" },
          { id: "c", task: "Task C" },
          { id: "d", task: "Task D" },
          { id: "e", task: "Task E" },
        ],
      });

      // Pre-populate state: a and b completed
      await source.writeState({
        queueRunId: "resume01",
        startedAt: "2026-01-01T00:00:00Z",
        items: {
          a: { status: "completed", branch: "knox/a-resume01" },
          b: { status: "completed", branch: "knox/b-resume01" },
          c: { status: "pending" },
          d: { status: "pending" },
          e: { status: "pending" },
        },
      });

      const engineCalls: KnoxEngineOptions[] = [];
      const orchestrator = new Orchestrator({
        source,
        image: "knox-agent:latest",
        envVars: [],
        allowedIPs: [],
        dir: Deno.cwd(),
        logDir,
        resume: true,
        engineFactory: mockEngineFactory(new Map(), engineCalls),
      });

      const report = await orchestrator.run();

      // Only c, d, e should have been run
      assertEquals(engineCalls.length, 3);
      assertEquals(engineCalls[0].task, "Task C");
      assertEquals(engineCalls[1].task, "Task D");
      assertEquals(engineCalls[2].task, "Task E");

      // queueRunId preserved
      assertEquals(report.queueRunId, "resume01");

      // All 5 items completed
      assertEquals(report.items.every((i) => i.status === "completed"), true);
    } finally {
      await cleanup(logDir);
    }
  });

  await t.step("resume re-attempts failed items", async () => {
    const logDir = await setupLogDir();
    try {
      const source = new MockQueueSource({
        items: [
          { id: "a", task: "Task A" },
          { id: "b", task: "Task B", dependsOn: ["a"] },
          { id: "c", task: "Task C", dependsOn: ["b"] },
        ],
      });

      // a completed, b failed, c blocked
      await source.writeState({
        queueRunId: "resume02",
        startedAt: "2026-01-01T00:00:00Z",
        items: {
          a: { status: "completed", branch: "knox/a-resume02" },
          b: { status: "failed" },
          c: { status: "blocked", blockedBy: "b" },
        },
      });

      const engineCalls: KnoxEngineOptions[] = [];
      const orchestrator = new Orchestrator({
        source,
        image: "knox-agent:latest",
        envVars: [],
        allowedIPs: [],
        dir: Deno.cwd(),
        logDir,
        resume: true,
        engineFactory: mockEngineFactory(new Map(), engineCalls),
      });

      const report = await orchestrator.run();

      // b and c should have been re-run
      assertEquals(engineCalls.length, 2);
      assertEquals(engineCalls[0].task, "Task B");
      assertEquals(engineCalls[1].task, "Task C");

      // All completed
      assertEquals(report.items.every((i) => i.status === "completed"), true);
    } finally {
      await cleanup(logDir);
    }
  });

  await t.step("fresh run overwrites state file", async () => {
    const logDir = await setupLogDir();
    try {
      const source = new MockQueueSource({
        items: [
          { id: "a", task: "Task A" },
          { id: "b", task: "Task B" },
        ],
      });

      // Pre-populate state
      await source.writeState({
        queueRunId: "old-run",
        startedAt: "2026-01-01T00:00:00Z",
        items: {
          a: { status: "completed" },
          b: { status: "failed" },
        },
      });

      const engineCalls: KnoxEngineOptions[] = [];
      const orchestrator = new Orchestrator({
        source,
        image: "knox-agent:latest",
        envVars: [],
        allowedIPs: [],
        dir: Deno.cwd(),
        logDir,
        // No resume flag
        engineFactory: mockEngineFactory(new Map(), engineCalls),
      });

      const report = await orchestrator.run();

      // Both items should have been run (fresh start)
      assertEquals(engineCalls.length, 2);
      // New run ID (not "old-run")
      assert(report.queueRunId !== "old-run");
    } finally {
      await cleanup(logDir);
    }
  });

  // --- Phase 4: AbortSignal ---

  await t.step("onEvent callback receives (itemId, event) pairs", async () => {
    const logDir = await setupLogDir();
    try {
      const events: Array<{ itemId: string; event: KnoxEvent }> = [];

      // Engine that emits events via onEvent callback
      const engineFactory = (opts: KnoxEngineOptions) => ({
        run(): Promise<KnoxOutcome> {
          opts.onEvent?.({ type: "container:created", containerId: "c1" });
          opts.onEvent?.({ type: "loop:start", loop: 1, maxLoops: 3 });
          opts.onEvent?.({ type: "loop:end", loop: 1, completed: true });
          opts.onEvent?.({ type: "bundle:extracted", path: "/tmp/b" });

          return Promise.resolve({
            ok: true,
            result: {
              runId: opts.runId!,
              completed: true,
              aborted: false,
              loopsRun: 1,
              maxLoops: 3,
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              durationMs: 100,
              model: "sonnet",
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

      const source = new MockQueueSource({
        items: [
          { id: "a", task: "Task A" },
          { id: "b", task: "Task B" },
        ],
      });

      const orchestrator = new Orchestrator({
        source,
        image: "knox-agent:latest",
        envVars: [],
        allowedIPs: [],
        dir: Deno.cwd(),
        logDir,
        engineFactory,
        onEvent: (itemId, event) => events.push({ itemId, event }),
      });

      await orchestrator.run();

      // Each item should have emitted 4 events
      const aEvents = events.filter((e) => e.itemId === "a");
      const bEvents = events.filter((e) => e.itemId === "b");

      assertEquals(aEvents.length, 4);
      assertEquals(aEvents[0].event.type, "container:created");
      assertEquals(aEvents[1].event.type, "loop:start");
      assertEquals(aEvents[2].event.type, "loop:end");
      assertEquals(aEvents[3].event.type, "bundle:extracted");

      assertEquals(bEvents.length, 4);
      assertEquals(bEvents[0].event.type, "container:created");
    } finally {
      await cleanup(logDir);
    }
  });

  await t.step("AbortSignal cancels remaining items", async () => {
    const logDir = await setupLogDir();
    try {
      const controller = new AbortController();
      let callCount = 0;

      const engineFactory = (opts: KnoxEngineOptions) => ({
        run(): Promise<KnoxOutcome> {
          callCount++;
          if (callCount === 1) {
            controller.abort();
          }
          return Promise.resolve({
            ok: true,
            result: {
              runId: opts.runId!,
              completed: true,
              aborted: false,
              loopsRun: 1,
              maxLoops: 10,
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              durationMs: 10,
              model: "sonnet",
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

      const source = new MockQueueSource({
        items: [
          { id: "a", task: "Task A" },
          { id: "b", task: "Task B" },
          { id: "c", task: "Task C" },
        ],
      });

      const orchestrator = new Orchestrator({
        source,
        image: "knox-agent:latest",
        envVars: [],
        allowedIPs: [],
        dir: Deno.cwd(),
        logDir,
        signal: controller.signal,
        engineFactory,
      });

      const report = await orchestrator.run();

      // First item completed, remaining should be blocked by abort
      assertEquals(report.items[0].status, "completed");
      // At least some items should be blocked
      const blockedCount = report.items.filter((i) =>
        i.status === "blocked"
      ).length;
      assert(blockedCount > 0, "Expected some items to be blocked by abort");
    } finally {
      await cleanup(logDir);
    }
  });
});
