import { parse as parseYaml } from "@std/yaml";
import type { QueueItem, ValidationError } from "./types.ts";

/** Known frontmatter field names for a QueueItem. */
const KNOWN_FIELDS = new Set([
  "dependsOn",
  "model",
  "features",
  "prepare",
  "image",
  "check",
  "group",
  "maxLoops",
  "env",
  "cpu",
  "memory",
]);

/** Fields that have been removed with migration instructions. */
const REMOVED_FIELDS: Record<string, string> = {
  setup:
    "The `setup` field has been renamed to `prepare`. Please update your configuration.",
};

/** Result type for parseMarkdownTask. */
export type ParseResult =
  | { ok: true; item: QueueItem; warnings?: ValidationError[] }
  | { ok: false; errors: ValidationError[] };

/**
 * Parse a Markdown task file into a QueueItem.
 *
 * - Returns null for _-prefixed filenames (reserved for config files).
 * - Returns { ok: false, errors } for validation failures.
 * - Returns { ok: true, item } on success, with optional warnings for unknown fields.
 */
export function parseMarkdownTask(
  content: string,
  filename: string,
): ParseResult | null {
  // Skip _-prefixed filenames (config files like _defaults.yaml)
  const basename = filename.split("/").pop() ?? filename;
  if (basename.startsWith("_")) {
    return null;
  }

  // Derive id from filename by stripping .md extension
  const id = basename.replace(/\.md$/, "");

  // Split frontmatter from body
  const { frontmatter, body, parseError } = splitFrontmatter(content);

  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  if (parseError) {
    errors.push({ field: "frontmatter", message: parseError });
    return { ok: false, errors };
  }

  // Parse YAML frontmatter
  // deno-lint-ignore no-explicit-any
  let fm: Record<string, any> = {};

  if (frontmatter !== null) {
    try {
      const parsed = parseYaml(frontmatter);
      if (parsed === null || parsed === undefined) {
        // Empty frontmatter is fine
      } else if (
        typeof parsed === "object" && !Array.isArray(parsed)
      ) {
        fm = parsed as Record<string, unknown>;
      } else {
        errors.push({
          field: "frontmatter",
          message: "Frontmatter must be a YAML mapping",
        });
        return { ok: false, errors };
      }
    } catch (e) {
      errors.push({
        field: "frontmatter",
        message: `Malformed YAML frontmatter: ${e instanceof Error ? e.message : String(e)}`,
      });
      return { ok: false, errors };
    }
  }

  // Check for removed fields and warn about unknown fields
  for (const key of Object.keys(fm)) {
    if (key in REMOVED_FIELDS) {
      errors.push({ field: key, message: REMOVED_FIELDS[key] });
    } else if (!KNOWN_FIELDS.has(key)) {
      warnings.push({ field: key, message: `Unknown frontmatter field: '${key}'` });
    }
  }

  // Validate body — the task description is required
  const task = body.trim();
  if (!task) {
    errors.push({ field: "task", message: "Task body must not be empty" });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Normalize dependsOn: single string → string[]
  let dependsOn: string[] | undefined;
  if (fm.dependsOn !== undefined) {
    if (typeof fm.dependsOn === "string") {
      dependsOn = [fm.dependsOn];
    } else if (Array.isArray(fm.dependsOn)) {
      dependsOn = fm.dependsOn as string[];
    }
  }

  const item: QueueItem = {
    id,
    task,
    ...(dependsOn !== undefined && { dependsOn }),
    ...(fm.model !== undefined && { model: fm.model }),
    ...(fm.features !== undefined && { features: fm.features }),
    ...(fm.prepare !== undefined && { prepare: fm.prepare }),
    ...(fm.image !== undefined && { image: fm.image }),
    ...(fm.check !== undefined && { check: fm.check }),
    ...(fm.group !== undefined && { group: fm.group }),
    ...(fm.maxLoops !== undefined && { maxLoops: fm.maxLoops }),
    ...(fm.env !== undefined && { env: fm.env }),
    ...(fm.cpu !== undefined && { cpu: String(fm.cpu) }),
    ...(fm.memory !== undefined && { memory: String(fm.memory) }),
  };

  return {
    ok: true,
    item,
    ...(warnings.length > 0 && { warnings }),
  };
}

/** Split YAML frontmatter from Markdown body. */
function splitFrontmatter(content: string): {
  frontmatter: string | null;
  body: string;
  parseError?: string;
} {
  // Frontmatter must start with exactly "---" on the first line
  if (!content.startsWith("---")) {
    return { frontmatter: null, body: content };
  }

  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) {
    // Entire content is just "---" with no newline — no frontmatter
    return { frontmatter: null, body: content };
  }

  const firstLine = content.slice(0, firstNewline);
  if (firstLine !== "---") {
    // First line has extra content after --- (not a valid frontmatter delimiter)
    return { frontmatter: null, body: content };
  }

  // Search for the closing "---" on its own line in the remainder
  const rest = content.slice(firstNewline + 1);
  const closingMatch = rest.match(/^---[ \t]*$/m);

  if (!closingMatch || closingMatch.index === undefined) {
    // No closing delimiter — not valid frontmatter, treat as plain body
    return { frontmatter: null, body: content };
  }

  const frontmatter = rest.slice(0, closingMatch.index);
  // Body is everything after the closing --- line (skip the newline after it)
  const afterClosing = rest.slice(
    closingMatch.index + closingMatch[0].length,
  );
  const body = afterClosing.startsWith("\n")
    ? afterClosing.slice(1)
    : afterClosing;

  return { frontmatter, body };
}
