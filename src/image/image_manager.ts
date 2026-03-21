import { encodeHex } from "@std/encoding/hex";
import { dirname, fromFileUrl, join } from "@std/path";
import type { ContainerRuntime } from "../runtime/container_runtime.ts";
import type { ImageId } from "../types.ts";

const BASE_IMAGE_TAG = "knox-agent:latest";

export class ImageManager {
  private runtime: ContainerRuntime;

  constructor(runtime: ContainerRuntime) {
    this.runtime = runtime;
  }

  /** Ensure the base Knox agent image exists, building if needed. */
  async ensureBaseImage(): Promise<ImageId> {
    if (await this.runtime.imageExists(BASE_IMAGE_TAG)) {
      return BASE_IMAGE_TAG;
    }

    const dockerfileDir = join(
      dirname(fromFileUrl(import.meta.url)),
    );

    return await this.runtime.buildImage({
      context: dockerfileDir,
      tag: BASE_IMAGE_TAG,
    });
  }

  /**
   * Run setup commands in a networked container and cache the result.
   * Returns the image ID of the post-setup image.
   * If setupCommand is undefined/empty, returns the base image.
   */
  async ensureSetupImage(setupCommand?: string): Promise<ImageId> {
    const baseImage = await this.ensureBaseImage();
    if (!setupCommand) {
      return baseImage;
    }

    const cacheTag = await this.computeCacheTag(setupCommand);
    if (await this.runtime.imageExists(cacheTag)) {
      return cacheTag;
    }

    // Run setup in a networked container
    const containerId = await this.runtime.createContainer({
      image: baseImage,
      workdir: "/workspace",
      networkEnabled: true,
    });

    try {
      const result = await this.runtime.exec(
        containerId,
        ["sh", "-c", setupCommand],
        { workdir: "/workspace" },
      );

      if (result.exitCode !== 0) {
        throw new Error(
          `Setup command failed (exit ${result.exitCode}): ${result.stderr}`,
        );
      }

      // Commit the container state as a cached image
      await this.runtime.commit({
        container: containerId,
        tag: cacheTag,
        message: `knox setup: ${setupCommand}`,
      });

      return cacheTag;
    } finally {
      await this.runtime.stop(containerId);
      await this.runtime.remove(containerId);
    }
  }

  private async computeCacheTag(setupCommand: string): Promise<string> {
    const dockerfileContent = await Deno.readTextFile(
      join(dirname(fromFileUrl(import.meta.url)), "Dockerfile"),
    );
    const input = dockerfileContent + "\n---\n" + setupCommand;
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(input),
    );
    const prefix = encodeHex(new Uint8Array(hash)).slice(0, 16);
    return `knox-cache:${prefix}`;
  }
}
