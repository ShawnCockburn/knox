import { assertEquals, assertStringIncludes } from "@std/assert";
import { FeatureRegistry } from "../../src/shared/features/feature_registry.ts";
import { join } from "@std/path";

// Use the real features/ directory at repo root
const FEATURES_DIR = join(
  new URL(".", import.meta.url).pathname,
  "../../features",
);

Deno.test("FeatureRegistry", async (t) => {
  await t.step("loads python feature metadata", async () => {
    const registry = new FeatureRegistry(FEATURES_DIR);
    await registry.load();

    const python = registry.get("python");
    assertEquals(python !== undefined, true);
    assertEquals(python!.name, "python");
    assertEquals(python!.defaultVersion, "3.12");
    assertEquals(python!.supportedVersions.includes("3.12"), true);
    assertEquals(python!.provides.includes("python"), true);
  });

  await t.step("all() returns sorted features", async () => {
    const registry = new FeatureRegistry(FEATURES_DIR);
    await registry.load();

    const all = registry.all();
    assertEquals(all.length >= 1, true);
    // Already sorted alphabetically
    for (let i = 1; i < all.length; i++) {
      assertEquals(all[i - 1].name < all[i].name, true);
    }
  });

  await t.step("resolves bare feature name to default version", async () => {
    const registry = new FeatureRegistry(FEATURES_DIR);
    await registry.load();

    const result = await registry.resolve(["python"]);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.features.length, 1);
      assertEquals(result.features[0].name, "python");
      assertEquals(result.features[0].version, "3.12");
      assertEquals(result.features[0].installScriptContent.length > 0, true);
    }
  });

  await t.step("resolves versioned feature spec", async () => {
    const registry = new FeatureRegistry(FEATURES_DIR);
    await registry.load();

    const result = await registry.resolve([{
      name: "python",
      version: "3.11",
    }]);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.features[0].version, "3.11");
    }
  });

  await t.step("rejects unknown feature", async () => {
    const registry = new FeatureRegistry(FEATURES_DIR);
    await registry.load();

    const result = await registry.resolve(["nonexistent"]);
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.errors[0], "Unknown feature");
    }
  });

  await t.step("rejects unsupported version with image hint", async () => {
    const registry = new FeatureRegistry(FEATURES_DIR);
    await registry.load();

    const result = await registry.resolve([{ name: "python", version: "2.7" }]);
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.errors[0], "does not support version");
      assertStringIncludes(result.errors[0], "image:");
    }
  });

  await t.step("parseSpec handles bare string", () => {
    const spec = FeatureRegistry.parseSpec("python");
    assertEquals(spec, "python");
  });

  await t.step("parseSpec handles colon-separated string", () => {
    const spec = FeatureRegistry.parseSpec("python:3.12");
    assertEquals(spec, { name: "python", version: "3.12" });
  });

  await t.step("parseSpec handles object form", () => {
    const spec = FeatureRegistry.parseSpec({ python: "3.12" });
    assertEquals(spec, { name: "python", version: "3.12" });
  });

  await t.step("loads all 6 features", async () => {
    const registry = new FeatureRegistry(FEATURES_DIR);
    await registry.load();

    const all = registry.all();
    assertEquals(all.length, 6);
    const names = all.map((f) => f.name);
    assertEquals(names, ["deno", "go", "node", "python", "ruby", "rust"]);
  });

  await t.step("multi-feature stacking resolves correctly", async () => {
    const registry = new FeatureRegistry(FEATURES_DIR);
    await registry.load();

    const result = await registry.resolve(["python", "deno", "rust"]);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.features.length, 3);
      // Sorted alphabetically
      assertEquals(result.features[0].name, "deno");
      assertEquals(result.features[1].name, "python");
      assertEquals(result.features[2].name, "rust");
    }
  });

  await t.step("declaration order does not affect sort", async () => {
    const registry = new FeatureRegistry(FEATURES_DIR);
    await registry.load();

    const result1 = await registry.resolve(["python", "deno"]);
    const result2 = await registry.resolve(["deno", "python"]);
    assertEquals(result1.ok, true);
    assertEquals(result2.ok, true);
    if (result1.ok && result2.ok) {
      assertEquals(result1.features[0].name, result2.features[0].name);
      assertEquals(result1.features[1].name, result2.features[1].name);
    }
  });

  await t.step("node feature has correct metadata", async () => {
    const registry = new FeatureRegistry(FEATURES_DIR);
    await registry.load();

    const node = registry.get("node");
    assertEquals(node !== undefined, true);
    assertEquals(node!.provides.includes("node"), true);
    assertEquals(node!.provides.includes("npm"), true);
  });
});
