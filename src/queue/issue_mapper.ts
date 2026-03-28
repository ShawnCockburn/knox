import type { GitHubIssue } from "./github_client.ts";
import { parseMarkdownTask } from "./markdown_task_parser.ts";
import type { QueueItem, ValidationError } from "./types.ts";

/** Maximum length for the slugified title portion of an item ID. */
const MAX_SLUG_LENGTH = 50;

/**
 * Slugify a string for use in item IDs and branch names.
 * Lowercase, non-alphanumeric → hyphens, collapse consecutive hyphens,
 * trim trailing hyphens.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/-$/, "")
    .replace(/^-/, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-$/, ""); // trim trailing hyphen after truncation
}

/**
 * Generate the item ID for a GitHub issue.
 * Format: `gh-<number>-<slugified-title>` with 50-char title cap.
 */
export function issueToItemId(issue: GitHubIssue): string {
  const slug = slugify(issue.title);
  return `gh-${issue.number}-${slug}`;
}

/** Result of mapping an issue to a QueueItem. */
export type MapResult =
  | { ok: true; item: QueueItem; warnings?: ValidationError[] }
  | { ok: false; errors: ValidationError[] };

/**
 * Convert a GitHub Issue into a QueueItem.
 *
 * The issue body is parsed using the same Markdown task parser used for
 * directory-based queues. The item ID is derived from the issue number
 * and slugified title.
 */
export function mapIssueToQueueItem(issue: GitHubIssue): MapResult {
  const itemId = issueToItemId(issue);

  // Use the issue body as the markdown content, or empty string if null
  const body = issue.body ?? "";

  // Parse using the existing markdown task parser.
  // We use a synthetic filename so the parser derives the id from it.
  // We'll override the id afterward since we want gh-N-slug format.
  const parseResult = parseMarkdownTask(body, `${itemId}.md`);

  if (parseResult === null) {
    // Shouldn't happen — the synthetic filename doesn't start with _
    return {
      ok: false,
      errors: [{ message: `Issue #${issue.number}: unexpected parse skip` }],
    };
  }

  if (!parseResult.ok) {
    return {
      ok: false,
      errors: parseResult.errors.map((e) => ({
        ...e,
        message: `Issue #${issue.number} (${issue.title}): ${e.message}`,
      })),
    };
  }

  // The parser derived the id from the filename, which is already our itemId
  const item: QueueItem = {
    ...parseResult.item,
    id: itemId,
  };

  return {
    ok: true,
    item,
    ...(parseResult.warnings && { warnings: parseResult.warnings }),
  };
}
