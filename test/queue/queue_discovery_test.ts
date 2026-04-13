import { assertEquals } from "@std/assert";
import {
  discoverQueues,
  multiQueueExitCode,
  runMultiQueue,
} from "../../src/queue/queue_discovery.ts";
import { DirectoryQueueSource } from "../../src/queue/directory_queue_source.ts";
import type { DiscoveredQueue } from "../../src/queue/queue_discovery.ts";
import type {
  OrchestratorOptions,
  QueueReport,
} from "../../src/queue/orchestrator.ts";
import { createFakeExecutionContext } from "../fake_execution.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "knox-discovery-test-" });
}

async function cleanup(dir: string) {
  await Deno.remove(dir, { recursive: true });
}

/** Build a minimal QueueReport for testing. */
function fakeReport(
  id: string,
  status: "completed" | "failed" = "completed",
): QueueReport {
  return {
    queueRunId: `run-${id}`,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 100,
    items: [{ id: "task", status }],
    manifest: { items: [] },
  };
}

/** Build a DiscoveredQueue pointing at a temp path (no actual files needed when using mock). */
function fakeQueue(name: string, path = `/tmp/${name}`): DiscoveredQueue {
  return { name, path };
}

const defaultExecution = createFakeExecutionContext();

// ---------------------------------------------------------------------------
// discoverQueues
// ---------------------------------------------------------------------------

Deno.test("discoverQueues - discovers all queue directories under .knox/queues/", async () => {
  const root = await makeTempDir();
  try {
    const queuesDir = `${root}/.knox/queues`;
    await Deno.mkdir(`${queuesDir}/auth-refactor`, { recursive: true });
    await Deno.writeTextFile(
      `${queuesDir}/auth-refactor/task1.md`,
      "Do auth thing",
    );

    const queues = await discoverQueues(root);
    assertEquals(queues.length, 1);
    assertEquals(queues[0].name, "auth-refactor");
  } finally {
    await cleanup(root);
  }
});

Deno.test("discoverQueues - ignores directories without .md files", async () => {
  const root = await makeTempDir();
  try {
    const queuesDir = `${root}/.knox/queues`;
    await Deno.mkdir(`${queuesDir}/no-tasks`, { recursive: true });
    await Deno.writeTextFile(`${queuesDir}/no-tasks/notes.txt`, "not a task");

    const queues = await discoverQueues(root);
    assertEquals(queues.length, 0);
  } finally {
    await cleanup(root);
  }
});

Deno.test("discoverQueues - ignores directories where all .md files are _-prefixed", async () => {
  const root = await makeTempDir();
  try {
    const queuesDir = `${root}/.knox/queues`;
    await Deno.mkdir(`${queuesDir}/docs-only`, { recursive: true });
    await Deno.writeTextFile(`${queuesDir}/docs-only/_README.md`, "docs");

    const queues = await discoverQueues(root);
    assertEquals(queues.length, 0);
  } finally {
    await cleanup(root);
  }
});

Deno.test("discoverQueues - ignores files (non-directories) in .knox/queues/", async () => {
  const root = await makeTempDir();
  try {
    const queuesDir = `${root}/.knox/queues`;
    await Deno.mkdir(queuesDir, { recursive: true });
    await Deno.writeTextFile(`${queuesDir}/stray.md`, "I am not a dir");

    const queues = await discoverQueues(root);
    assertEquals(queues.length, 0);
  } finally {
    await cleanup(root);
  }
});

Deno.test("discoverQueues - returns empty list if .knox/queues/ doesn't exist", async () => {
  const root = await makeTempDir();
  try {
    const queues = await discoverQueues(root);
    assertEquals(queues.length, 0);
  } finally {
    await cleanup(root);
  }
});

Deno.test("discoverQueues - returns queues sorted alphabetically", async () => {
  const root = await makeTempDir();
  try {
    const queuesDir = `${root}/.knox/queues`;
    for (const name of ["zebra", "alpha", "mango"]) {
      await Deno.mkdir(`${queuesDir}/${name}`, { recursive: true });
      await Deno.writeTextFile(
        `${queuesDir}/${name}/task.md`,
        `Task for ${name}`,
      );
    }

    const queues = await discoverQueues(root);
    assertEquals(queues.map((q) => q.name), ["alpha", "mango", "zebra"]);
  } finally {
    await cleanup(root);
  }
});

Deno.test("discoverQueues - qualifies directory if it has both _-prefixed and normal .md files", async () => {
  const root = await makeTempDir();
  try {
    const queuesDir = `${root}/.knox/queues`;
    await Deno.mkdir(`${queuesDir}/mixed`, { recursive: true });
    await Deno.writeTextFile(`${queuesDir}/mixed/_README.md`, "docs");
    await Deno.writeTextFile(`${queuesDir}/mixed/task.md`, "real task");

    const queues = await discoverQueues(root);
    assertEquals(queues.length, 1);
    assertEquals(queues[0].name, "mixed");
  } finally {
    await cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// DirectoryQueueSource
// ---------------------------------------------------------------------------

Deno.test("DirectoryQueueSource - loads .md files as queue items", async () => {
  const dir = await makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/fix-bug.md`, "Fix the login bug");
    await Deno.writeTextFile(`${dir}/add-tests.md`, "Add unit tests");
    await Deno.writeTextFile(`${dir}/_README.md`, "Ignored docs");
    await Deno.writeTextFile(`${dir}/notes.txt`, "Ignored file");

    const source = new DirectoryQueueSource(dir);
    const result = await source.load();

    assertEquals(result.ok, true);
    if (result.ok) {
      const ids = result.manifest.items.map((i) => i.id);
      assertEquals(ids, ["add-tests", "fix-bug"]); // sorted
      assertEquals(
        result.manifest.items.find((i) => i.id === "fix-bug")?.task,
        "Fix the login bug",
      );
    }
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// runMultiQueue
// ---------------------------------------------------------------------------

Deno.test("runMultiQueue - runs queues sequentially (verify order via callbacks)", async () => {
  const order: string[] = [];
  const queues: DiscoveredQueue[] = [
    fakeQueue("alpha"),
    fakeQueue("beta"),
    fakeQueue("gamma"),
  ];

  await runMultiQueue({
    queues,
    execution: defaultExecution,
    image: "test",
    dir: "/tmp",
    onQueueStart: (name) => order.push(`start:${name}`),
    onQueueComplete: (name) => order.push(`done:${name}`),
    _orchestratorFactory: (_opts: OrchestratorOptions) => ({
      run: (): Promise<QueueReport> => Promise.resolve(fakeReport("task")),
    }),
  });

  assertEquals(order, [
    "start:alpha",
    "done:alpha",
    "start:beta",
    "done:beta",
    "start:gamma",
    "done:gamma",
  ]);
});

Deno.test("runMultiQueue - combined report includes all queues", async () => {
  const queues: DiscoveredQueue[] = [
    fakeQueue("q1"),
    fakeQueue("q2"),
  ];

  const report = await runMultiQueue({
    queues,
    execution: defaultExecution,
    image: "test",
    dir: "/tmp",
    _orchestratorFactory: (_opts: OrchestratorOptions) => ({
      run: (): Promise<QueueReport> => Promise.resolve(fakeReport("task")),
    }),
  });

  assertEquals(report.queues.length, 2);
  assertEquals(report.queues[0].name, "q1");
  assertEquals(report.queues[1].name, "q2");
});

Deno.test("runMultiQueue - abort mid-queue skips remaining queues", async () => {
  const started: string[] = [];
  const controller = new AbortController();

  const queues: DiscoveredQueue[] = [
    fakeQueue("first"),
    fakeQueue("second"),
    fakeQueue("third"),
  ];

  await runMultiQueue({
    queues,
    execution: defaultExecution,
    image: "test",
    dir: "/tmp",
    signal: controller.signal,
    onQueueStart: (name) => started.push(name),
    _orchestratorFactory: (_opts: OrchestratorOptions) => ({
      run: (): Promise<QueueReport> => {
        controller.abort();
        return Promise.resolve(fakeReport("task"));
      },
    }),
  });

  // Only the first queue ran; second and third were skipped
  assertEquals(started, ["first"]);
});

Deno.test("runMultiQueue - calls queueOutput.deliver() for each completed queue", async () => {
  const delivered: Array<{ name: string }> = [];

  const queues: DiscoveredQueue[] = [fakeQueue("a"), fakeQueue("b")];

  await runMultiQueue({
    queues,
    execution: defaultExecution,
    image: "test",
    dir: "/tmp",
    queueOutput: {
      deliver: (name: string) => {
        delivered.push({ name });
      },
    },
    _orchestratorFactory: (_opts: OrchestratorOptions) => ({
      run: (): Promise<QueueReport> => Promise.resolve(fakeReport("task")),
    }),
  });

  assertEquals(delivered.map((d) => d.name), ["a", "b"]);
});

// ---------------------------------------------------------------------------
// multiQueueExitCode
// ---------------------------------------------------------------------------

Deno.test("multiQueueExitCode - returns 0 when all items completed", () => {
  const report = {
    queues: [
      { name: "q1", report: fakeReport("task", "completed") },
      { name: "q2", report: fakeReport("task", "completed") },
    ],
    durationMs: 200,
  };
  assertEquals(multiQueueExitCode(report), 0);
});

Deno.test("multiQueueExitCode - returns 1 when any item failed", () => {
  const report = {
    queues: [
      { name: "q1", report: fakeReport("task", "completed") },
      { name: "q2", report: fakeReport("task", "failed") },
    ],
    durationMs: 200,
  };
  assertEquals(multiQueueExitCode(report), 1);
});
