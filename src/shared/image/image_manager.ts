import { encodeHex } from "@std/encoding/hex";
import { dirname, fromFileUrl, join } from "@std/path";
import type { ContainerRuntime } from "../runtime/container_runtime.ts";
import type { ImageId } from "../types.ts";
import type { ResolvedFeature } from "../features/feature_registry.ts";

const BASE_IMAGE_TAG = "knox-agent:latest";

/** Options for building a feature-based image. */
export interface FeatureImageOptions {
  features?: ResolvedFeature[];
  prepare?: string;
}

/** Options for building a custom image with optional prepare. */
export interface CustomImageOptions {
  image: string;
  prepare?: string;
}

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
   * Build pipeline: base image → features (alphabetical) → prepare → commit + cache.
   * Returns the base image if no features or prepare are specified.
   */
  async ensureFeatureImage(options: FeatureImageOptions): Promise<ImageId> {
    const baseImage = await this.ensureBaseImage();
    const { features, prepare } = options;

    if ((!features || features.length === 0) && !prepare) {
      return baseImage;
    }

    const cacheTag = await this.computeFeatureCacheTag(features, prepare);
    if (await this.runtime.imageExists(cacheTag)) {
      return cacheTag;
    }

    // Create a networked container from the base image
    const containerId = await this.runtime.createContainer({
      image: baseImage,
      workdir: "/workspace",
      networkEnabled: true,
    });

    try {
      // Install features in alphabetical order (already sorted by registry)
      if (features && features.length > 0) {
        for (const feature of features) {
          // Copy install script into container
          const tmpFile = await Deno.makeTempFile({ suffix: ".sh" });
          try {
            await Deno.writeTextFile(tmpFile, feature.installScriptContent);
            await this.runtime.copyIn(
              containerId,
              tmpFile,
              `/tmp/install-${feature.name}.sh`,
            );
          } finally {
            await Deno.remove(tmpFile).catch(() => {});
          }

          const result = await this.runtime.exec(
            containerId,
            ["bash", `/tmp/install-${feature.name}.sh`, feature.version],
            { workdir: "/workspace", user: "root" },
          );

          if (result.exitCode !== 0) {
            throw new Error(
              `Feature '${feature.name}' install failed (exit ${result.exitCode}): ${result.stderr}`,
            );
          }
        }
      }

      // Run prepare command
      if (prepare) {
        const result = await this.runtime.exec(
          containerId,
          ["sh", "-c", prepare],
          { workdir: "/workspace", user: "root" },
        );

        if (result.exitCode !== 0) {
          throw new Error(
            `Prepare command failed (exit ${result.exitCode}): ${result.stderr}`,
          );
        }
      }

      // Commit the container state as a cached image
      const featureNames = features?.map((f) => `${f.name}:${f.version}`) ?? [];
      const message = [
        ...featureNames.map((f) => `feature: ${f}`),
        ...(prepare ? [`prepare: ${prepare}`] : []),
      ].join(", ");

      await this.runtime.commit({
        container: containerId,
        tag: cacheTag,
        message: `knox: ${message}`,
      });

      return cacheTag;
    } finally {
      await this.runtime.stop(containerId);
      await this.runtime.remove(containerId);
    }
  }

  /**
   * Build an image from a custom base image with optional prepare command.
   * If no prepare, returns the image directly (no caching).
   * If prepare specified, runs it and caches the result.
   */
  async ensureCustomImage(options: CustomImageOptions): Promise<ImageId> {
    const { image, prepare } = options;

    if (!prepare) {
      return image;
    }

    const cacheTag = await this.computeCustomImageCacheTag(image, prepare);
    if (await this.runtime.imageExists(cacheTag)) {
      return cacheTag;
    }

    const containerId = await this.runtime.createContainer({
      image,
      workdir: "/workspace",
      networkEnabled: true,
    });

    try {
      const result = await this.runtime.exec(
        containerId,
        ["sh", "-c", prepare],
        { workdir: "/workspace", user: "root" },
      );

      if (result.exitCode !== 0) {
        throw new Error(
          `Prepare command failed (exit ${result.exitCode}): ${result.stderr}`,
        );
      }

      await this.runtime.commit({
        container: containerId,
        tag: cacheTag,
        message: `knox custom-image: ${image} + prepare: ${prepare}`,
      });

      return cacheTag;
    } finally {
      await this.runtime.stop(containerId);
      await this.runtime.remove(containerId);
    }
  }

  /**
   * Remove all Docker images tagged with the knox-cache: prefix.
   * Returns the number of images removed.
   */
  async clearCache(): Promise<number> {
    return await this.runtime.removeImagesByPrefix("knox-cache:");
  }

  /**
   * Legacy: Run setup commands in a networked container and cache the result.
   * @deprecated Use ensureFeatureImage instead.
   */
  async ensureSetupImage(setupCommand?: string): Promise<ImageId> {
    return await this.ensureFeatureImage({
      prepare: setupCommand,
    });
  }

  private async computeFeatureCacheTag(
    features?: ResolvedFeature[],
    prepare?: string,
  ): Promise<string> {
    const dockerfileContent = await Deno.readTextFile(
      join(dirname(fromFileUrl(import.meta.url)), "Dockerfile"),
    );

    const parts: string[] = [dockerfileContent];

    if (features && features.length > 0) {
      // Features are already sorted alphabetically by the registry
      for (const f of features) {
        parts.push(`${f.name}:${f.version}:${f.installScriptContent}`);
      }
    }

    if (prepare) {
      parts.push(`prepare:${prepare}`);
    }

    const input = parts.join("\n---\n");
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(input),
    );
    const prefix = encodeHex(new Uint8Array(hash)).slice(0, 16);
    return `knox-cache:${prefix}`;
  }

  private async computeCustomImageCacheTag(
    image: string,
    prepare: string,
  ): Promise<string> {
    const input = `custom:${image}\n---\nprepare:${prepare}`;
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(input),
    );
    const prefix = encodeHex(new Uint8Array(hash)).slice(0, 16);
    return `knox-cache:${prefix}`;
  }
}
