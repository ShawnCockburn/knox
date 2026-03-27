import { dirname, fromFileUrl, join } from "@std/path";

/** Metadata for a single feature. */
export interface FeatureMetadata {
  readonly name: string;
  readonly description: string;
  readonly defaultVersion: string;
  readonly supportedVersions: string[];
  readonly provides: string[];
}

/** A resolved feature with name, version, and paths. */
export interface ResolvedFeature {
  readonly name: string;
  readonly version: string;
  readonly installScriptPath: string;
  readonly installScriptContent: string;
}

/** Feature spec as parsed from config: bare string or name:version pair. */
export type FeatureSpec = string | { name: string; version: string };

/**
 * Loads feature metadata from the features/ directory at the repo root
 * and resolves/validates feature specs.
 */
export class FeatureRegistry {
  private metadata = new Map<string, FeatureMetadata>();
  private featuresDir: string;

  constructor(featuresDir?: string) {
    this.featuresDir = featuresDir ??
      join(dirname(fromFileUrl(import.meta.url)), "../../../features");
  }

  /** Load all feature metadata from disk. */
  async load(): Promise<void> {
    this.metadata.clear();
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(this.featuresDir);
    } catch {
      return; // No features directory is valid (empty registry)
    }

    for await (const entry of entries) {
      if (!entry.isDirectory) continue;
      const metadataPath = join(this.featuresDir, entry.name, "metadata.json");
      try {
        const text = await Deno.readTextFile(metadataPath);
        const meta = JSON.parse(text) as FeatureMetadata;
        this.metadata.set(meta.name, meta);
      } catch {
        // Skip features with missing/invalid metadata
      }
    }
  }

  /** Get metadata for all loaded features. */
  all(): FeatureMetadata[] {
    return [...this.metadata.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  /** Get metadata for a single feature. */
  get(name: string): FeatureMetadata | undefined {
    return this.metadata.get(name);
  }

  /**
   * Parse a feature config value into a FeatureSpec.
   * Accepts: "python", "python:3.12", { python: "3.12" }
   */
  static parseSpec(
    value: string | Record<string, string>,
  ): FeatureSpec {
    if (typeof value === "string") {
      if (value.includes(":")) {
        const [name, version] = value.split(":", 2);
        return { name, version };
      }
      return value; // bare name
    }
    // Object form: { python: "3.12" }
    const entries = Object.entries(value);
    if (entries.length !== 1) {
      throw new Error(
        `Feature object must have exactly one key, got: ${JSON.stringify(value)}`,
      );
    }
    const [name, version] = entries[0];
    return { name, version };
  }

  /**
   * Resolve and validate feature specs into ResolvedFeatures.
   * Returns errors for unknown features, unsupported versions, or conflicts.
   */
  async resolve(
    specs: FeatureSpec[],
  ): Promise<
    { ok: true; features: ResolvedFeature[] } | {
      ok: false;
      errors: string[];
    }
  > {
    const errors: string[] = [];
    const resolved: ResolvedFeature[] = [];
    const allProvides = new Map<string, string>(); // binary → feature name

    for (const spec of specs) {
      const name = typeof spec === "string" ? spec : spec.name;
      const meta = this.metadata.get(name);

      if (!meta) {
        errors.push(
          `Unknown feature: '${name}'. Available features: ${
            [...this.metadata.keys()].join(", ") || "none"
          }`,
        );
        continue;
      }

      const version = typeof spec === "string"
        ? meta.defaultVersion
        : spec.version;

      if (!meta.supportedVersions.includes(version)) {
        errors.push(
          `Feature '${name}' does not support version '${version}'. ` +
            `Supported: ${meta.supportedVersions.join(", ")}. ` +
            `If you need a custom version, use the \`image:\` escape hatch.`,
        );
        continue;
      }

      // Check for binary conflicts
      for (const binary of meta.provides) {
        const existing = allProvides.get(binary);
        if (existing && existing !== name) {
          errors.push(
            `Binary conflict: both '${existing}' and '${name}' provide '${binary}'`,
          );
        }
        allProvides.set(binary, name);
      }

      const installScriptPath = join(
        this.featuresDir,
        name,
        "install.sh",
      );
      const installScriptContent = await Deno.readTextFile(installScriptPath);

      resolved.push({ name, version, installScriptPath, installScriptContent });
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    // Sort alphabetically by name for deterministic cache keys
    resolved.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, features: resolved };
  }
}
