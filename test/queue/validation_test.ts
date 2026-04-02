import { assertEquals, assertStringIncludes } from "@std/assert";
import { validateManifest } from "../../src/queue/validation.ts";

Deno.test("validateManifest", async (t) => {
  await t.step("accepts a valid minimal manifest", () => {
    const result = validateManifest({
      items: [
        { id: "a", task: "Do thing A" },
        { id: "b", task: "Do thing B" },
      ],
    });
    assertEquals(result.errors.length, 0);
    assertEquals(result.manifest!.items.length, 2);
    assertEquals(result.manifest!.items[0].id, "a");
  });

  await t.step("accepts valid manifest with defaults and concurrency", () => {
    const result = validateManifest({
      concurrency: 3,
      defaults: { difficulty: "complex", maxLoops: 5 },
      items: [
        { id: "a", task: "Do A" },
        { id: "b", task: "Do B", dependsOn: ["a"] },
      ],
    });
    assertEquals(result.errors.length, 0);
    assertEquals(result.manifest!.concurrency, 3);
    assertEquals(result.manifest!.defaults!.difficulty, "complex");
    assertEquals(result.manifest!.defaults!.maxLoops, 5);
  });

  await t.step("accepts valid manifest with groups", () => {
    const result = validateManifest({
      items: [
        { id: "a", task: "Do A", group: "feature" },
        { id: "b", task: "Do B", group: "feature", dependsOn: ["a"] },
        { id: "c", task: "Do C", group: "feature", dependsOn: ["b"] },
      ],
    });
    assertEquals(result.errors.length, 0);
  });

  // --- Structural validation ---

  await t.step("rejects null input", () => {
    const result = validateManifest(null);
    assertEquals(result.errors.length, 1);
    assertStringIncludes(result.errors[0].message, "YAML mapping");
  });

  await t.step("rejects missing items array", () => {
    const result = validateManifest({ foo: "bar" });
    assertEquals(result.errors.length, 1);
    assertStringIncludes(result.errors[0].message, "'items' array");
  });

  await t.step("rejects item missing id", () => {
    const result = validateManifest({
      items: [{ task: "Do something" }],
    });
    assertEquals(result.errors.length, 1);
    assertStringIncludes(result.errors[0].message, "'id' is required");
  });

  await t.step("rejects item missing task", () => {
    const result = validateManifest({
      items: [{ id: "a" }],
    });
    assertEquals(result.errors.length, 1);
    assertStringIncludes(result.errors[0].message, "'task' is required");
  });

  await t.step("rejects duplicate item IDs", () => {
    const result = validateManifest({
      items: [
        { id: "a", task: "First" },
        { id: "a", task: "Second" },
      ],
    });
    assertEquals(result.errors.length, 1);
    assertStringIncludes(result.errors[0].message, "Duplicate item ID: 'a'");
  });

  await t.step("rejects non-positive concurrency", () => {
    const result = validateManifest({
      concurrency: 0,
      items: [{ id: "a", task: "Do A" }],
    });
    assertEquals(result.errors.length, 1);
    assertStringIncludes(result.errors[0].message, "positive integer");
  });

  await t.step("rejects non-integer concurrency", () => {
    const result = validateManifest({
      concurrency: 1.5,
      items: [{ id: "a", task: "Do A" }],
    });
    assertEquals(result.errors.length, 1);
    assertStringIncludes(result.errors[0].message, "positive integer");
  });

  await t.step("collects multiple structural errors at once", () => {
    const result = validateManifest({
      items: [
        { id: "a" }, // missing task
        { id: "a", task: "Dup" }, // duplicate id
      ],
    });
    // Should have at least 2 errors
    assertEquals(result.errors.length >= 2, true);
  });

  // --- Referential validation ---

  await t.step("rejects dangling dependsOn reference", () => {
    const result = validateManifest({
      items: [
        { id: "a", task: "Do A", dependsOn: ["nonexistent"] },
      ],
    });
    assertEquals(result.errors.length, 1);
    assertStringIncludes(
      result.errors[0].message,
      "unknown item 'nonexistent'",
    );
  });

  await t.step("rejects multiple dangling references", () => {
    const result = validateManifest({
      items: [
        { id: "a", task: "Do A", dependsOn: ["x", "y"] },
      ],
    });
    assertEquals(result.errors.length, 2);
  });

  // --- Cycle detection ---

  await t.step("rejects simple cycle (A → B → A)", () => {
    const result = validateManifest({
      items: [
        { id: "a", task: "Do A", dependsOn: ["b"] },
        { id: "b", task: "Do B", dependsOn: ["a"] },
      ],
    });
    assertEquals(result.errors.length, 1);
    assertStringIncludes(result.errors[0].message, "cycle");
  });

  await t.step("rejects self-cycle (A → A)", () => {
    const result = validateManifest({
      items: [
        { id: "a", task: "Do A", dependsOn: ["a"] },
      ],
    });
    assertEquals(result.errors.length, 1);
    assertStringIncludes(result.errors[0].message, "cycle");
  });

  await t.step("rejects three-node cycle with cycle path in message", () => {
    const result = validateManifest({
      items: [
        { id: "a", task: "Do A", dependsOn: ["c"] },
        { id: "b", task: "Do B", dependsOn: ["a"] },
        { id: "c", task: "Do C", dependsOn: ["b"] },
      ],
    });
    assertEquals(result.errors.length, 1);
    assertStringIncludes(result.errors[0].message, "cycle");
    // The cycle path should mention all three nodes
    const msg = result.errors[0].message;
    assertEquals(msg.includes("a"), true);
    assertEquals(msg.includes("b"), true);
    assertEquals(msg.includes("c"), true);
  });

  // --- Group linearity ---

  await t.step("rejects diamond within a group", () => {
    const result = validateManifest({
      items: [
        { id: "a", task: "Do A", group: "g" },
        { id: "b", task: "Do B", group: "g", dependsOn: ["a"] },
        { id: "c", task: "Do C", group: "g", dependsOn: ["a"] },
        { id: "d", task: "Do D", group: "g", dependsOn: ["b", "c"] },
      ],
    });
    assertEquals(result.errors.length >= 1, true);
    assertStringIncludes(result.errors[0].message, "diamond");
  });

  await t.step("allows diamond across different groups", () => {
    const result = validateManifest({
      items: [
        { id: "a", task: "Do A", group: "g1" },
        { id: "b", task: "Do B", group: "g2", dependsOn: ["a"] },
        { id: "c", task: "Do C", group: "g2", dependsOn: ["a"] },
      ],
    });
    // 'a' is in g1, b and c are in g2 — the diamond is within g2 only if
    // there's an item in g2 that depends on both b and c. Here there isn't.
    // 'a' has two in-g2 dependents but 'a' is in g1, so this is fine.
    assertEquals(result.errors.length, 0);
  });

  // --- Environment field validation ---

  await t.step("rejects features + image on same item", () => {
    const result = validateManifest({
      items: [
        {
          id: "a",
          task: "Do A",
          features: ["python"],
          image: "my-image:latest",
        },
      ],
    });
    assertEquals(result.errors.length >= 1, true);
    assertStringIncludes(result.errors[0].message, "cannot be used together");
  });

  await t.step("rejects features + image on defaults", () => {
    const result = validateManifest({
      defaults: { features: ["python"], image: "my-image:latest" },
      items: [
        { id: "a", task: "Do A" },
      ],
    });
    assertEquals(result.errors.length >= 1, true);
    assertStringIncludes(result.errors[0].message, "cannot be used together");
  });

  await t.step("accepts features + envSetup on same item", () => {
    const result = validateManifest({
      items: [
        {
          id: "a",
          task: "Do A",
          features: ["python:3.12"],
          envSetup: "apt-get install -y jq",
        },
      ],
    });
    assertEquals(result.errors.length, 0);
  });

  await t.step("accepts image + envSetup on same item", () => {
    const result = validateManifest({
      items: [
        {
          id: "a",
          task: "Do A",
          image: "python:3.12-slim",
          envSetup: "apt-get install -y jq",
        },
      ],
    });
    assertEquals(result.errors.length, 0);
  });

  await t.step("rejects legacy model in defaults with migration guidance", () => {
    const result = validateManifest({
      defaults: { model: "opus" },
      items: [{ id: "a", task: "Do A" }],
    });
    assertEquals(result.errors.length, 1);
    assertStringIncludes(result.errors[0].message, "replaced by 'difficulty'");
  });

  await t.step("rejects legacy model on item with migration guidance", () => {
    const result = validateManifest({
      items: [{ id: "a", task: "Do A", model: "opus" }],
    });
    assertEquals(result.errors.length, 1);
    assertStringIncludes(result.errors[0].message, "replaced by 'difficulty'");
  });

  await t.step("rejects invalid difficulty values", () => {
    const result = validateManifest({
      items: [{ id: "a", task: "Do A", difficulty: "hard" }],
    });
    assertEquals(result.errors.length, 1);
    assertStringIncludes(result.errors[0].message, "must be one of");
  });

  await t.step("accepts projectSetup on item and defaults", () => {
    const result = validateManifest({
      defaults: { projectSetup: "deno install" },
      items: [
        {
          id: "a",
          task: "Do A",
          projectSetup: "npm install",
        },
      ],
    });
    assertEquals(result.errors.length, 0);
  });
});
