import { assertEquals, assertStringIncludes } from "@std/assert";
import { DirectoryQueueSource } from "../../src/queue/directory_queue_source.ts";

/** Create a temp directory and write a set of files into it. */
async function setup(
  files: Record<string, string>,
): Promise<{ dir: string }> {
  const dir = await Deno.makeTempDir({ prefix: "knox-dir-queue-test-" });
  for (const [name, content] of Object.entries(files)) {
    await Deno.writeTextFile(`${dir}/${name}`, content);
  }
  return { dir };
}

async function cleanup(dir: string) {
  await Deno.remove(dir, { recursive: true });
}

Deno.test("DirectoryQueueSource", async (t) => {
  await t.step("loads multiple .md files into a valid manifest", async () => {
    const { dir } = await setup({
      "a.md": "Do thing A",
      "b.md": `---
dependsOn:
  - a
---
Do thing B
`,
    });
    try {
      const source = new DirectoryQueueSource(dir);
      const result = await source.load();
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.manifest.items.length, 2);
        assertEquals(result.manifest.items[0].id, "a");
        assertEquals(result.manifest.items[1].id, "b");
        assertEquals(result.manifest.items[1].dependsOn, ["a"]);
      }
    } finally {
      await cleanup(dir);
    }
  });

  await t.step(
    "reads _defaults.yaml and merges into manifest defaults",
    async () => {
      const { dir } = await setup({
        "a.md": "Do thing A",
        "_defaults.yaml": "difficulty: complex\nmaxLoops: 5\n",
      });
      try {
        const source = new DirectoryQueueSource(dir);
        const result = await source.load();
        assertEquals(result.ok, true);
        if (result.ok) {
          assertEquals(result.manifest.defaults!.difficulty, "complex");
          assertEquals(result.manifest.defaults!.maxLoops, 5);
        }
      } finally {
        await cleanup(dir);
      }
    },
  );

  await t.step("works without _defaults.yaml", async () => {
    const { dir } = await setup({
      "task.md": "Do the task",
    });
    try {
      const source = new DirectoryQueueSource(dir);
      const result = await source.load();
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.manifest.defaults, undefined);
        assertEquals(result.manifest.items.length, 1);
        assertEquals(result.manifest.items[0].id, "task");
      }
    } finally {
      await cleanup(dir);
    }
  });

  await t.step("skips non-.md files and _-prefixed files", async () => {
    const { dir } = await setup({
      "a.md": "Task A",
      "_skipped.md": "Should be skipped",
      "notes.txt": "Not a task file",
      "queue.yaml": "items: []",
      "_defaults.yaml": "difficulty: balanced\n",
    });
    try {
      const source = new DirectoryQueueSource(dir);
      const result = await source.load();
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.manifest.items.length, 1);
        assertEquals(result.manifest.items[0].id, "a");
      }
    } finally {
      await cleanup(dir);
    }
  });

  await t.step(
    "returns validation errors for broken dependsOn references",
    async () => {
      const { dir } = await setup({
        "a.md": `---
dependsOn:
  - nonexistent
---
Task A
`,
      });
      try {
        const source = new DirectoryQueueSource(dir);
        const result = await source.load();
        assertEquals(result.ok, false);
        if (!result.ok) {
          assertEquals(result.errors.length >= 1, true);
          assertStringIncludes(result.errors[0].message, "nonexistent");
        }
      } finally {
        await cleanup(dir);
      }
    },
  );

  await t.step(
    "state sidecar .state.yaml read/write/update roundtrip",
    async () => {
      const { dir } = await setup({
        "a.md": "Task A",
        "b.md": "Task B",
      });
      try {
        const source = new DirectoryQueueSource(dir);

        // No state file initially
        assertEquals(await source.readState(), null);

        // Write state
        await source.writeState({
          queueRunId: "run-abc",
          startedAt: "2026-01-01T00:00:00Z",
          items: {
            a: { status: "completed", startedAt: "2026-01-01T00:00:00Z" },
          },
        });

        const state = await source.readState();
        assertEquals(state!.queueRunId, "run-abc");
        assertEquals(state!.items["a"].status, "completed");

        // Update an item
        await source.update("b", { status: "in_progress" });
        const updated = await source.readState();
        assertEquals(updated!.items["a"].status, "completed");
        assertEquals(updated!.items["b"].status, "in_progress");

        // Verify state file lives inside the directory
        assertStringIncludes(source.getStatePath(), dir);
        assertStringIncludes(source.getStatePath(), ".state.yaml");
      } finally {
        await cleanup(dir);
      }
    },
  );

  await t.step("empty directory returns an error", async () => {
    const { dir } = await setup({});
    try {
      const source = new DirectoryQueueSource(dir);
      const result = await source.load();
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.errors.length >= 1, true);
        assertStringIncludes(result.errors[0].message, "No .md files");
      }
    } finally {
      await cleanup(dir);
    }
  });

  await t.step(
    "file ordering is deterministic (sorted by filename)",
    async () => {
      const { dir } = await setup({
        "c.md": "Task C",
        "a.md": "Task A",
        "b.md": "Task B",
      });
      try {
        const source = new DirectoryQueueSource(dir);
        const result = await source.load();
        assertEquals(result.ok, true);
        if (result.ok) {
          assertEquals(result.manifest.items.map((i) => i.id), ["a", "b", "c"]);
        }
      } finally {
        await cleanup(dir);
      }
    },
  );

  await t.step("update() preserves existing state entries", async () => {
    const { dir } = await setup({
      "a.md": "Task A",
      "b.md": "Task B",
    });
    try {
      const source = new DirectoryQueueSource(dir);
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
    const { dir } = await setup({
      "a.md": "Task A",
    });
    try {
      const source = new DirectoryQueueSource(dir);
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
});
