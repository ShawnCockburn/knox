import { assertEquals } from "@std/assert";
import { MockRuntime } from "../runtime/mock_runtime.ts";
import { ImageManager } from "../../src/shared/image/image_manager.ts";
import type { ResolvedFeature } from "../../src/shared/features/feature_registry.ts";

const MOCK_FEATURE: ResolvedFeature = {
  name: "python",
  version: "3.12",
  installScriptPath: "/features/python/install.sh",
  installScriptContent: '#!/bin/bash\necho "install python $1"',
};

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

  await t.step(
    "ensureFeatureImage returns base image when no features or prepare",
    async () => {
      const runtime = new MockRuntime();
      runtime.imageExistsResult = true;
      const manager = new ImageManager(runtime);

      const image = await manager.ensureFeatureImage({});

      assertEquals(image, "knox-agent:latest");
      assertEquals(runtime.callsTo("createContainer").length, 0);
    },
  );

  await t.step("ensureFeatureImage runs prepare and commits", async () => {
    const runtime = new MockRuntime();
    let imageExistsCallCount = 0;
    runtime.imageExists = (tag: string) => {
      runtime.calls.push({ method: "imageExists", args: [tag] });
      imageExistsCallCount++;
      return Promise.resolve(imageExistsCallCount === 1);
    };
    runtime.execResults = [{ exitCode: 0, stdout: "", stderr: "" }];
    const manager = new ImageManager(runtime);

    const image = await manager.ensureFeatureImage({ prepare: "npm install" });

    assertEquals(runtime.callsTo("createContainer").length, 1);
    assertEquals(runtime.callsTo("exec").length, 1);
    assertEquals(runtime.callsTo("commit").length, 1);
    assertEquals(runtime.callsTo("stop").length, 1);
    assertEquals(runtime.callsTo("remove").length, 1);

    const execCall = runtime.callsTo("exec")[0];
    const command = execCall.args[1] as string[];
    assertEquals(command, ["sh", "-c", "npm install"]);
    assertEquals(image.startsWith("knox-cache:"), true);
  });

  await t.step(
    "ensureFeatureImage installs features then prepare",
    async () => {
      const runtime = new MockRuntime();
      let imageExistsCallCount = 0;
      runtime.imageExists = (tag: string) => {
        runtime.calls.push({ method: "imageExists", args: [tag] });
        imageExistsCallCount++;
        return Promise.resolve(imageExistsCallCount === 1);
      };
      // exec results: feature install success, prepare success
      runtime.execResults = [
        { exitCode: 0, stdout: "", stderr: "" },
        { exitCode: 0, stdout: "", stderr: "" },
      ];
      const manager = new ImageManager(runtime);

      const image = await manager.ensureFeatureImage({
        features: [MOCK_FEATURE],
        prepare: "pip install flask",
      });

      // Should have: copyIn (install script), exec (feature install), exec (prepare)
      assertEquals(runtime.callsTo("copyIn").length, 1);
      const execCalls = runtime.callsTo("exec");
      assertEquals(execCalls.length, 2);

      // First exec: feature install script
      const featureCmd = execCalls[0].args[1] as string[];
      assertEquals(featureCmd[0], "bash");
      assertEquals(featureCmd[2], "3.12");

      // Second exec: prepare command
      const prepareCmd = execCalls[1].args[1] as string[];
      assertEquals(prepareCmd, ["sh", "-c", "pip install flask"]);

      assertEquals(image.startsWith("knox-cache:"), true);
    },
  );

  await t.step("ensureFeatureImage uses cache when available", async () => {
    const runtime = new MockRuntime();
    runtime.imageExistsResult = true;
    const manager = new ImageManager(runtime);

    const image = await manager.ensureFeatureImage({ prepare: "npm install" });

    assertEquals(runtime.callsTo("createContainer").length, 0);
    assertEquals(runtime.callsTo("exec").length, 0);
    assertEquals(image.startsWith("knox-cache:"), true);
  });

  await t.step(
    "ensureFeatureImage produces deterministic cache tags",
    async () => {
      const runtime = new MockRuntime();
      runtime.imageExistsResult = true;
      const manager = new ImageManager(runtime);

      const image1 = await manager.ensureFeatureImage({
        features: [MOCK_FEATURE],
        prepare: "pip install flask",
      });
      const image2 = await manager.ensureFeatureImage({
        features: [MOCK_FEATURE],
        prepare: "pip install flask",
      });

      assertEquals(image1, image2);
    },
  );

  await t.step(
    "ensureFeatureImage produces different tags for different inputs",
    async () => {
      const runtime = new MockRuntime();
      runtime.imageExistsResult = true;
      const manager = new ImageManager(runtime);

      const image1 = await manager.ensureFeatureImage({
        prepare: "npm install",
      });
      const image2 = await manager.ensureFeatureImage({
        prepare: "pip install -r requirements.txt",
      });

      assertEquals(image1 !== image2, true);
    },
  );

  await t.step(
    "cache key changes when feature version changes",
    async () => {
      const runtime = new MockRuntime();
      runtime.imageExistsResult = true;
      const manager = new ImageManager(runtime);

      const feature312 = { ...MOCK_FEATURE, version: "3.12" };
      const feature311 = { ...MOCK_FEATURE, version: "3.11" };

      const image1 = await manager.ensureFeatureImage({
        features: [feature312],
      });
      const image2 = await manager.ensureFeatureImage({
        features: [feature311],
      });

      assertEquals(image1 !== image2, true);
    },
  );

  await t.step(
    "cache key changes when install script content changes",
    async () => {
      const runtime = new MockRuntime();
      runtime.imageExistsResult = true;
      const manager = new ImageManager(runtime);

      const featureA = { ...MOCK_FEATURE, installScriptContent: "script-v1" };
      const featureB = { ...MOCK_FEATURE, installScriptContent: "script-v2" };

      const image1 = await manager.ensureFeatureImage({ features: [featureA] });
      const image2 = await manager.ensureFeatureImage({ features: [featureB] });

      assertEquals(image1 !== image2, true);
    },
  );

  // Legacy backward-compat
  await t.step(
    "ensureSetupImage returns base image when no setup",
    async () => {
      const runtime = new MockRuntime();
      runtime.imageExistsResult = true;
      const manager = new ImageManager(runtime);

      const image = await manager.ensureSetupImage();

      assertEquals(image, "knox-agent:latest");
      assertEquals(runtime.callsTo("createContainer").length, 0);
    },
  );

  await t.step("ensureSetupImage delegates to ensureFeatureImage", async () => {
    const runtime = new MockRuntime();
    let imageExistsCallCount = 0;
    runtime.imageExists = (tag: string) => {
      runtime.calls.push({ method: "imageExists", args: [tag] });
      imageExistsCallCount++;
      return Promise.resolve(imageExistsCallCount === 1);
    };
    runtime.execResults = [{ exitCode: 0, stdout: "", stderr: "" }];
    const manager = new ImageManager(runtime);

    const image = await manager.ensureSetupImage("npm install");

    assertEquals(runtime.callsTo("createContainer").length, 1);
    assertEquals(image.startsWith("knox-cache:"), true);
  });

  await t.step(
    "ensureCustomImage returns image directly without prepare",
    async () => {
      const runtime = new MockRuntime();
      const manager = new ImageManager(runtime);

      const image = await manager.ensureCustomImage({
        image: "python:3.12-slim",
      });

      assertEquals(image, "python:3.12-slim");
      assertEquals(runtime.callsTo("createContainer").length, 0);
    },
  );

  await t.step("ensureCustomImage builds and caches with prepare", async () => {
    const runtime = new MockRuntime();
    let imageExistsCallCount = 0;
    runtime.imageExists = (tag: string) => {
      runtime.calls.push({ method: "imageExists", args: [tag] });
      imageExistsCallCount++;
      // No cached image exists
      return Promise.resolve(false);
    };
    runtime.execResults = [{ exitCode: 0, stdout: "", stderr: "" }];
    const manager = new ImageManager(runtime);

    const image = await manager.ensureCustomImage({
      image: "python:3.12-slim",
      prepare: "pip install flask",
    });

    assertEquals(runtime.callsTo("createContainer").length, 1);
    assertEquals(runtime.callsTo("exec").length, 1);
    assertEquals(runtime.callsTo("commit").length, 1);
    assertEquals(image.startsWith("knox-cache:"), true);
  });

  await t.step(
    "custom image cache key differs from feature cache key",
    async () => {
      const runtime = new MockRuntime();
      runtime.imageExistsResult = true;
      const manager = new ImageManager(runtime);

      const featureImage = await manager.ensureFeatureImage({
        prepare: "pip install flask",
      });
      // Need to ensure base image for custom doesn't interfere
      // Custom image doesn't call ensureBaseImage, so cache tags are different by construction
      // since custom uses "custom:" prefix in hash input
      const customImage = await manager.ensureCustomImage({
        image: "python:3.12-slim",
        prepare: "pip install flask",
      });

      assertEquals(featureImage !== customImage, true);
    },
  );
});
