import { assertEquals } from "@std/assert";
import {
  issueToItemId,
  mapIssueToQueueItem,
  slugify,
} from "../../src/queue/issue_mapper.ts";
import type { GitHubIssue } from "../../src/queue/github_client.ts";

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

Deno.test("slugify — basic alphanumeric string", () => {
  assertEquals(slugify("Hello World"), "hello-world");
});

Deno.test("slugify — special characters become hyphens", () => {
  assertEquals(slugify("Fix: bug #42 in auth!"), "fix-bug-42-in-auth");
});

Deno.test("slugify — consecutive non-alphanumeric collapsed to single hyphen", () => {
  assertEquals(slugify("foo---bar___baz"), "foo-bar-baz");
});

Deno.test("slugify — trailing hyphens trimmed", () => {
  assertEquals(slugify("trailing-hyphen--"), "trailing-hyphen");
});

Deno.test("slugify — leading hyphens trimmed", () => {
  assertEquals(slugify("--leading"), "leading");
});

Deno.test("slugify — truncated to 50 characters", () => {
  const long = "a".repeat(60);
  assertEquals(slugify(long).length, 50);
});

Deno.test("slugify — truncation does not leave trailing hyphen", () => {
  // 49 a's then a space then more text → slug would be aaaa...a-more
  // After truncation at 50, ensure no trailing hyphen
  const input = "a".repeat(49) + " more text here";
  const result = slugify(input);
  assertEquals(result.endsWith("-"), false);
  assertEquals(result.length <= 50, true);
});

Deno.test("slugify — empty string", () => {
  assertEquals(slugify(""), "");
});

// ---------------------------------------------------------------------------
// issueToItemId
// ---------------------------------------------------------------------------

Deno.test("issueToItemId — format is gh-<number>-<slug>", () => {
  const issue: GitHubIssue = {
    number: 42,
    title: "Add OAuth Support",
    body: "Do the thing",
    author: { login: "user" },
    labels: [],
  };
  assertEquals(issueToItemId(issue), "gh-42-add-oauth-support");
});

Deno.test("issueToItemId — long title is truncated", () => {
  const issue: GitHubIssue = {
    number: 1,
    title:
      "This is a very long issue title that exceeds the fifty character limit for slugification",
    body: "body",
    author: { login: "user" },
    labels: [],
  };
  const id = issueToItemId(issue);
  // gh-1- prefix + slug (max 50 chars)
  assertEquals(id.startsWith("gh-1-"), true);
  const slugPart = id.slice("gh-1-".length);
  assertEquals(slugPart.length <= 50, true);
});

// ---------------------------------------------------------------------------
// mapIssueToQueueItem
// ---------------------------------------------------------------------------

Deno.test("mapIssueToQueueItem — plain body (no frontmatter)", () => {
  const issue: GitHubIssue = {
    number: 10,
    title: "Implement feature X",
    body: "Build the feature X with tests",
    author: { login: "alice" },
    labels: [{ name: "agent/knox" }],
  };

  const result = mapIssueToQueueItem(issue);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.item.id, "gh-10-implement-feature-x");
    assertEquals(result.item.task, "Build the feature X with tests");
    assertEquals(result.item.difficulty, undefined);
    assertEquals(result.item.dependsOn, undefined);
  }
});

Deno.test("mapIssueToQueueItem — body with frontmatter", () => {
  const issue: GitHubIssue = {
    number: 7,
    title: "Setup Auth",
    body: `---
difficulty: complex
maxLoops: 5
features:
  - python:3.12
---
Implement OAuth2 authentication`,
    author: { login: "bob" },
    labels: [{ name: "agent/knox" }],
  };

  const result = mapIssueToQueueItem(issue);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.item.id, "gh-7-setup-auth");
    assertEquals(result.item.difficulty, "complex");
    assertEquals(result.item.maxLoops, 5);
    assertEquals(result.item.features, ["python:3.12"]);
    assertEquals(result.item.task, "Implement OAuth2 authentication");
  }
});

Deno.test("mapIssueToQueueItem — body with dependsOn", () => {
  const issue: GitHubIssue = {
    number: 15,
    title: "Add tests",
    body: `---
dependsOn:
  - gh-10-implement-feature-x
---
Write integration tests for feature X`,
    author: { login: "alice" },
    labels: [],
  };

  const result = mapIssueToQueueItem(issue);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.item.dependsOn, ["gh-10-implement-feature-x"]);
  }
});

Deno.test("mapIssueToQueueItem — empty body returns error", () => {
  const issue: GitHubIssue = {
    number: 3,
    title: "Empty issue",
    body: "",
    author: { login: "user" },
    labels: [],
  };

  const result = mapIssueToQueueItem(issue);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.errors.length >= 1, true);
    assertEquals(
      result.errors[0].message.includes("Task body must not be empty"),
      true,
    );
  }
});

Deno.test("mapIssueToQueueItem — null body returns error", () => {
  const issue = {
    number: 4,
    title: "Null body issue",
    body: null,
    author: { login: "user" },
    labels: [],
  } as unknown as GitHubIssue;

  const result = mapIssueToQueueItem(issue);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.errors.length >= 1, true);
  }
});

Deno.test("mapIssueToQueueItem — malformed frontmatter returns error", () => {
  const issue: GitHubIssue = {
    number: 5,
    title: "Bad YAML",
    body: `---
model: [unclosed
---
Some task`,
    author: { login: "user" },
    labels: [],
  };

  const result = mapIssueToQueueItem(issue);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.errors[0].message.includes("Issue #5"), true);
  }
});

Deno.test("mapIssueToQueueItem — unknown frontmatter fields produce warnings", () => {
  const issue: GitHubIssue = {
    number: 6,
    title: "Unknown fields",
    body: `---
unknownField: value
---
Do the task`,
    author: { login: "user" },
    labels: [],
  };

  const result = mapIssueToQueueItem(issue);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.warnings !== undefined, true);
    assertEquals(result.warnings![0].message.includes("unknownField"), true);
  }
});

Deno.test("mapIssueToQueueItem — group field is preserved", () => {
  const issue: GitHubIssue = {
    number: 20,
    title: "Grouped task",
    body: `---
group: feature-auth
---
Part of the auth feature group`,
    author: { login: "user" },
    labels: [],
  };

  const result = mapIssueToQueueItem(issue);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.item.group, "feature-auth");
  }
});
