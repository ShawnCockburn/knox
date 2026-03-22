import { assertEquals } from "@std/assert";
import { taskSlug } from "../../src/types.ts";

Deno.test("taskSlug", async (t) => {
  await t.step("converts to lowercase with hyphens", () => {
    assertEquals(taskSlug("Write Hello World"), "write-hello-world");
  });

  await t.step("removes special characters", () => {
    assertEquals(taskSlug("Fix bug #123!"), "fix-bug-123");
  });

  await t.step("truncates to 50 characters", () => {
    const long = "a".repeat(60);
    assertEquals(taskSlug(long).length, 50);
  });

  await t.step("trims leading/trailing hyphens", () => {
    assertEquals(taskSlug("--hello--"), "hello");
  });

  await t.step("collapses multiple non-alphanumeric chars", () => {
    assertEquals(taskSlug("hello   world!!!foo"), "hello-world-foo");
  });
});
