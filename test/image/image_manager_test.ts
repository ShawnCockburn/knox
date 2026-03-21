import { assertEquals } from "@std/assert";
import { MockRuntime } from "../runtime/mock_runtime.ts";
import { ImageManager } from "../../src/image/image_manager.ts";

Deno.test("ImageManager", async (t) => {
  await t.step("ensureBaseImage builds on first run", async () => {
    const runtime = new MockRuntime();
    runtime.imageExistsResult = false;
    const manager = new ImageManager(runtime);

    const image = await manager.ensureBaseImage();

    assertEquals(image, "knox-agent:latest");
    assertEquals(runtime.callsTo("imageExists").length, 1);
    assertEquals(runtime.callsTo("buildImage").length, 1);
  });

  await t.step("ensureBaseImage skips build when cached", async () => {
    const runtime = new MockRuntime();
    runtime.imageExistsResult = true;
    const manager = new ImageManager(runtime);

    const image = await manager.ensureBaseImage();

    assertEquals(image, "knox-agent:latest");
    assertEquals(runtime.callsTo("imageExists").length, 1);
    assertEquals(runtime.callsTo("buildImage").length, 0);
  });

  await t.step("ensureSetupImage returns base image when no setup", async () => {
    const runtime = new MockRuntime();
    runtime.imageExistsResult = true;
    const manager = new ImageManager(runtime);

    const image = await manager.ensureSetupImage();

    assertEquals(image, "knox-agent:latest");
    assertEquals(runtime.callsTo("createContainer").length, 0);
  });

  await t.step("ensureSetupImage runs setup and commits", async () => {
    const runtime = new MockRuntime();
    // First imageExists call (base image) returns true
    // Second imageExists call (cache tag) returns false
    let imageExistsCallCount = 0;
    runtime.imageExists = (tag: string) => {
      runtime.calls.push({ method: "imageExists", args: [tag] });
      imageExistsCallCount++;
      // Base image exists, cache image does not
      return Promise.resolve(imageExistsCallCount === 1);
    };
    runtime.execResults = [{ exitCode: 0, stdout: "", stderr: "" }];
    const manager = new ImageManager(runtime);

    const image = await manager.ensureSetupImage("npm install");

    // Should have created a container, exec'd setup, committed, then cleaned up
    assertEquals(runtime.callsTo("createContainer").length, 1);
    assertEquals(runtime.callsTo("exec").length, 1);
    assertEquals(runtime.callsTo("commit").length, 1);
    assertEquals(runtime.callsTo("stop").length, 1);
    assertEquals(runtime.callsTo("remove").length, 1);

    // Verify the setup command was passed correctly
    const execCall = runtime.callsTo("exec")[0];
    const command = execCall.args[1] as string[];
    assertEquals(command, ["sh", "-c", "npm install"]);

    // Image tag should be a knox-cache:... tag
    assertEquals(image.startsWith("knox-cache:"), true);
  });

  await t.step("ensureSetupImage uses cache when available", async () => {
    const runtime = new MockRuntime();
    // Both imageExists calls return true (base + cache)
    runtime.imageExistsResult = true;
    const manager = new ImageManager(runtime);

    const image = await manager.ensureSetupImage("npm install");

    // Should NOT have created a container
    assertEquals(runtime.callsTo("createContainer").length, 0);
    assertEquals(runtime.callsTo("exec").length, 0);
    assertEquals(image.startsWith("knox-cache:"), true);
  });

  await t.step("ensureSetupImage produces deterministic cache tags", async () => {
    const runtime = new MockRuntime();
    runtime.imageExistsResult = true;
    const manager = new ImageManager(runtime);

    const image1 = await manager.ensureSetupImage("npm install");
    const image2 = await manager.ensureSetupImage("npm install");

    assertEquals(image1, image2);
  });

  await t.step("ensureSetupImage produces different tags for different commands", async () => {
    const runtime = new MockRuntime();
    runtime.imageExistsResult = true;
    const manager = new ImageManager(runtime);

    const image1 = await manager.ensureSetupImage("npm install");
    const image2 = await manager.ensureSetupImage("pip install -r requirements.txt");

    // Tags should be different
    assertEquals(image1 !== image2, true);
  });
});
