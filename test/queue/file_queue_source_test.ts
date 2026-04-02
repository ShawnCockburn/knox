import { assertEquals, assertStringIncludes } from "@std/assert";
import { FileQueueSource } from "../../src/queue/file_queue_source.ts";

/** Create a temp directory and write a queue YAML file. */
async function setup(yaml: string): Promise<{ dir: string; path: string }> {
  const dir = await Deno.makeTempDir({ prefix: "knox-queue-test-" });
  const path = `${dir}/queue.yaml`;
  await Deno.writeTextFile(path, yaml);
  return { dir, path };
}

async function cleanup(dir: string) {
  await Deno.remove(dir, { recursive: true });
}

Deno.test("FileQueueSource", async (t) => {
  await t.step("loads a valid queue file", async () => {
    const { dir, path } = await setup(`
items:
  - id: a
    task: Do thing A
  - id: b
    task: Do thing B
    dependsOn:
      - a
`);
    try {
      const source = new FileQueueSource(path);
      const result = await source.load();
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.manifest.items.length, 2);
        assertEquals(result.manifest.items[0].id, "a");
        assertEquals(result.manifest.items[1].dependsOn, ["a"]);
      }
    } finally {
      await cleanup(dir);
    }
  });

  await t.step("loads manifest with defaults", async () => {
    const { dir, path } = await setup(`
defaults:
  difficulty: complex
  maxLoops: 5
items:
  - id: a
    task: Do A
`);
    try {
      const source = new FileQueueSource(path);
      const result = await source.load();
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.manifest.defaults!.difficulty, "complex");
        assertEquals(result.manifest.defaults!.maxLoops, 5);
      }
    } finally {
      await cleanup(dir);
    }
  });

  await t.step("returns validation errors for invalid manifest", async () => {
    const { dir, path } = await setup(`
items:
  - task: Missing id
`);
    try {
      const source = new FileQueueSource(path);
      const result = await source.load();
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.errors.length >= 1, true);
        assertStringIncludes(result.errors[0].message, "'id' is required");
      }
    } finally {
      await cleanup(dir);
    }
  });

  await t.step("update() writes to .state.yaml, not queue file", async () => {
    const { dir, path } = await setup(`
items:
  - id: a
    task: Do A
`);
    try {
      const source = new FileQueueSource(path);
      await source.update("a", {
        status: "in_progress",
        startedAt: "2026-01-01T00:00:00Z",
      });

      // Queue file unchanged
      const queueText = await Deno.readTextFile(path);
      assertEquals(queueText.includes("in_progress"), false);

      // State file created
      const stateText = await Deno.readTextFile(source.getStatePath());
      assertEquals(stateText.includes("in_progress"), true);
      assertEquals(stateText.includes("a"), true);
    } finally {
      await cleanup(dir);
    }
  });

  await t.step("update() preserves existing state entries", async () => {
    const { dir, path } = await setup(`
items:
  - id: a
    task: Do A
  - id: b
    task: Do B
`);
    try {
      const source = new FileQueueSource(path);
      await source.update("a", { status: "completed" });
      await source.update("b", { status: "in_progress" });

      const state = await source.readState();
      assertEquals(state!.items["a"].status, "completed");
      assertEquals(state!.items["b"].status, "in_progress");
    } finally {
      await cleanup(dir);
    }
  });

  await t.step("update() merges partial state for same item", async () => {
    const { dir, path } = await setup(`
items:
  - id: a
    task: Do A
`);
    try {
      const source = new FileQueueSource(path);
      await source.update("a", {
        status: "in_progress",
        startedAt: "2026-01-01T00:00:00Z",
      });
      await source.update("a", {
        status: "completed",
        finishedAt: "2026-01-01T00:01:00Z",
      });

      const state = await source.readState();
      assertEquals(state!.items["a"].status, "completed");
      assertEquals(state!.items["a"].startedAt, "2026-01-01T00:00:00Z");
      assertEquals(state!.items["a"].finishedAt, "2026-01-01T00:01:00Z");
    } finally {
      await cleanup(dir);
    }
  });

  await t.step("readState() returns null when no state file", async () => {
    const { dir, path } = await setup(`
items:
  - id: a
    task: Do A
`);
    try {
      const source = new FileQueueSource(path);
      const state = await source.readState();
      assertEquals(state, null);
    } finally {
      await cleanup(dir);
    }
  });

  await t.step("writeState() and readState() roundtrip", async () => {
    const { dir, path } = await setup(`
items:
  - id: a
    task: Do A
`);
    try {
      const source = new FileQueueSource(path);
      await source.writeState({
        queueRunId: "abc12345",
        startedAt: "2026-01-01T00:00:00Z",
        items: {
          a: { status: "completed", startedAt: "2026-01-01T00:00:00Z" },
        },
      });

      const state = await source.readState();
      assertEquals(state!.queueRunId, "abc12345");
      assertEquals(state!.items["a"].status, "completed");
    } finally {
      await cleanup(dir);
    }
  });

  await t.step("state file path derived from queue file path", () => {
    const source = new FileQueueSource("/path/to/queue.yaml");
    assertEquals(source.getStatePath(), "/path/to/queue.state.yaml");

    const source2 = new FileQueueSource("/path/to/queue.yml");
    assertEquals(source2.getStatePath(), "/path/to/queue.state.yaml");
  });
});
