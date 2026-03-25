import { assertEquals, assertStringIncludes } from "@std/assert";
import { parseMarkdownTask } from "../../src/queue/markdown_task_parser.ts";

Deno.test("parseMarkdownTask", async (t) => {
  await t.step("valid task with all frontmatter fields", () => {
    const content = `---
model: claude-opus-4-6
group: backend
dependsOn:
  - setup-db
  - setup-auth
setup: echo "setup"
check: echo "check"
maxLoops: 5
env:
  - MY_VAR=value
cpu: "2"
memory: "4Gi"
---

Implement the OAuth2 flow.
`;
    const result = parseMarkdownTask(content, "implement-oauth.md");
    assertEquals(result?.ok, true);
    if (result?.ok) {
      assertEquals(result.item.id, "implement-oauth");
      assertEquals(result.item.model, "claude-opus-4-6");
      assertEquals(result.item.group, "backend");
      assertEquals(result.item.dependsOn, ["setup-db", "setup-auth"]);
      assertEquals(result.item.setup, 'echo "setup"');
      assertEquals(result.item.check, 'echo "check"');
      assertEquals(result.item.maxLoops, 5);
      assertEquals(result.item.env, ["MY_VAR=value"]);
      assertEquals(result.item.cpu, "2");
      assertEquals(result.item.memory, "4Gi");
      assertEquals(result.item.task, "Implement the OAuth2 flow.");
    }
  });

  await t.step("valid task with minimal frontmatter (just body, no frontmatter)", () => {
    const content = "Just do this thing.";
    const result = parseMarkdownTask(content, "simple-task.md");
    assertEquals(result?.ok, true);
    if (result?.ok) {
      assertEquals(result.item.id, "simple-task");
      assertEquals(result.item.task, "Just do this thing.");
      assertEquals(result.item.model, undefined);
      assertEquals(result.item.dependsOn, undefined);
    }
  });

  await t.step("missing body (empty content after frontmatter) returns error", () => {
    const content = `---
model: claude-opus-4-6
---
`;
    const result = parseMarkdownTask(content, "empty-body.md");
    assertEquals(result?.ok, false);
    if (!result?.ok) {
      assertEquals(result.errors.some((e) => e.field === "task"), true);
    }
  });

  await t.step("malformed frontmatter returns error", () => {
    const content = `---
model: [unclosed bracket
---

Some body.
`;
    const result = parseMarkdownTask(content, "bad-yaml.md");
    assertEquals(result?.ok, false);
    if (!result?.ok) {
      assertEquals(result.errors.some((e) => e.field === "frontmatter"), true);
    }
  });

  await t.step("unknown frontmatter fields produce warning", () => {
    const content = `---
unknownField: value
anotherUnknown: 42
---

Do the thing.
`;
    const result = parseMarkdownTask(content, "unknown-field.md");
    assertEquals(result?.ok, true);
    if (result?.ok) {
      assertEquals(result.warnings?.some((w) => w.field === "unknownField"), true);
      assertEquals(result.warnings?.some((w) => w.field === "anotherUnknown"), true);
    }
  });

  await t.step("filename-to-id derivation strips .md extension", () => {
    const result = parseMarkdownTask("Do this.", "implement-oauth.md");
    assertEquals(result?.ok, true);
    if (result?.ok) {
      assertEquals(result.item.id, "implement-oauth");
    }
  });

  await t.step("filename-to-id handles path prefix", () => {
    const result = parseMarkdownTask("Do this.", "tasks/implement-oauth.md");
    assertEquals(result?.ok, true);
    if (result?.ok) {
      assertEquals(result.item.id, "implement-oauth");
    }
  });

  await t.step("dependsOn as single string normalizes to array", () => {
    const content = `---
dependsOn: other-task
---

Do this.
`;
    const result = parseMarkdownTask(content, "task.md");
    assertEquals(result?.ok, true);
    if (result?.ok) {
      assertEquals(result.item.dependsOn, ["other-task"]);
    }
  });

  await t.step("dependsOn as array is preserved", () => {
    const content = `---
dependsOn:
  - task-a
  - task-b
---

Do this.
`;
    const result = parseMarkdownTask(content, "task.md");
    assertEquals(result?.ok, true);
    if (result?.ok) {
      assertEquals(result.item.dependsOn, ["task-a", "task-b"]);
    }
  });

  await t.step(
    "body with complex markdown (code blocks containing ---, headers, lists) parses correctly",
    () => {
      const content = `---
model: claude-sonnet-4-6
---

# Task Title

Implement this feature.

\`\`\`bash
echo "---"
some-command --flag
\`\`\`

---

More content after a horizontal rule.

- Item 1
- Item 2
`;
      const result = parseMarkdownTask(content, "complex-task.md");
      assertEquals(result?.ok, true);
      if (result?.ok) {
        assertEquals(result.item.id, "complex-task");
        assertEquals(result.item.model, "claude-sonnet-4-6");
        assertStringIncludes(result.item.task, "# Task Title");
        assertStringIncludes(result.item.task, "---");
        assertStringIncludes(result.item.task, "Item 2");
        assertStringIncludes(result.item.task, 'echo "---"');
      }
    },
  );

  await t.step("_-prefixed filename is skipped (returns null)", () => {
    const result = parseMarkdownTask("Some content.", "_defaults.yaml");
    assertEquals(result, null);
  });

  await t.step("_-prefixed filename with path is skipped", () => {
    const result = parseMarkdownTask("Some content.", "tasks/_config.md");
    assertEquals(result, null);
  });
});
