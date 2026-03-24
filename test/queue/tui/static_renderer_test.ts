import { assertEquals } from "@std/assert";
import { formatStaticLine } from "../../../src/queue/tui/static_renderer.ts";
import type { KnoxEvent } from "../../../src/shared/types.ts";

Deno.test("StaticRenderer formatStaticLine", async (t) => {
  await t.step("container:created", () => {
    const line = formatStaticLine("item-a", {
      type: "container:created",
      containerId: "abc123",
    });
    assertEquals(line, "[item-a] container created");
  });

  await t.step("loop:start", () => {
    const line = formatStaticLine("item-a", {
      type: "loop:start",
      loop: 2,
      maxLoops: 5,
    });
    assertEquals(line, "[item-a] loop 2/5 started");
  });

  await t.step("loop:end completed", () => {
    const line = formatStaticLine("item-a", {
      type: "loop:end",
      loop: 1,
      completed: true,
    });
    assertEquals(line, "[item-a] agent completed");
  });

  await t.step("loop:end not completed", () => {
    const line = formatStaticLine("item-b", {
      type: "loop:end",
      loop: 3,
      completed: false,
    });
    assertEquals(line, "[item-b] loop 3 finished");
  });

  await t.step("check:failed", () => {
    const line = formatStaticLine("test-item", {
      type: "check:failed",
      loop: 1,
      output: "npm test exited 1",
    });
    assertEquals(line, "[test-item] check failed (loop 1)");
  });

  await t.step("nudge:result committed", () => {
    const line = formatStaticLine("item-a", {
      type: "nudge:result",
      committed: true,
    });
    assertEquals(line, "[item-a] committed changes");
  });

  await t.step("nudge:result no commit", () => {
    const line = formatStaticLine("item-a", {
      type: "nudge:result",
      committed: false,
    });
    assertEquals(line, "[item-a] nudge sent (no commit)");
  });

  await t.step("bundle:extracted", () => {
    const line = formatStaticLine("item-a", {
      type: "bundle:extracted",
      path: "/tmp/bundle.git",
    });
    assertEquals(line, "[item-a] bundle extracted");
  });

  await t.step("aborted", () => {
    const line = formatStaticLine("item-a", { type: "aborted" });
    assertEquals(line, "[item-a] aborted");
  });

  await t.step("full event sequence snapshot", () => {
    const events: Array<[string, KnoxEvent]> = [
      ["build", { type: "container:created", containerId: "c1" }],
      ["build", { type: "loop:start", loop: 1, maxLoops: 3 }],
      ["build", { type: "check:failed", loop: 1, output: "err" }],
      ["build", { type: "nudge:result", committed: true }],
      ["build", { type: "loop:start", loop: 2, maxLoops: 3 }],
      ["build", { type: "loop:end", loop: 2, completed: true }],
      ["build", { type: "bundle:extracted", path: "/tmp/b" }],
    ];

    const lines = events.map(([id, event]) => formatStaticLine(id, event));
    assertEquals(lines, [
      "[build] container created",
      "[build] loop 1/3 started",
      "[build] check failed (loop 1)",
      "[build] committed changes",
      "[build] loop 2/3 started",
      "[build] agent completed",
      "[build] bundle extracted",
    ]);
  });
});
