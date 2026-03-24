import { assert } from "@std/assert";
import { QueueTUI } from "../../../src/queue/tui/queue_tui.ts";
import { StaticRenderer } from "../../../src/queue/tui/static_renderer.ts";

Deno.test("Summary format: QueueTUI", async (t) => {
  await t.step("Completed: all items succeed", () => {
    const tui = new QueueTUI(["a", "b", "c"], {
      verbose: false,
      columns: 80,
      rows: 24,
      write: () => {},
    });

    tui.markItemRunning("a");
    tui.markItemCompleted("a");
    tui.markItemRunning("b");
    tui.markItemCompleted("b");
    tui.markItemRunning("c");
    tui.markItemCompleted("c");

    const summary = tui.formatSummary();
    assert(summary.startsWith("Completed:"), summary);
    assert(summary.includes("3 completed"), summary);
    assert(summary.match(/\(\d+s\)$/), `expected elapsed time, got: ${summary}`);
  });

  await t.step("Failed: some items failed", () => {
    const tui = new QueueTUI(["a", "b"], {
      verbose: false,
      columns: 80,
      rows: 24,
      write: () => {},
    });

    tui.markItemRunning("a");
    tui.markItemCompleted("a");
    tui.markItemRunning("b");
    tui.markItemFailed("b", "error");

    const summary = tui.formatSummary();
    assert(summary.startsWith("Failed:"), summary);
    assert(summary.includes("1 completed"), summary);
    assert(summary.includes("1 failed"), summary);
  });

  await t.step("Aborted: run was interrupted", () => {
    const tui = new QueueTUI(["a", "b", "c"], {
      verbose: false,
      columns: 80,
      rows: 24,
      write: () => {},
    });

    tui.markItemRunning("a");
    tui.markItemCompleted("a");
    tui.setAborting();
    tui.update("b", { type: "aborted" });
    tui.markItemBlocked("c", "aborted");

    const summary = tui.formatSummary();
    assert(summary.startsWith("Aborted:"), summary);
    assert(summary.includes("1 completed"), summary);
    assert(summary.includes("1 aborted"), summary);
    assert(summary.includes("1 blocked"), summary);
  });
});

Deno.test("Summary format: StaticRenderer", async (t) => {
  await t.step("Completed: all items succeed", () => {
    const renderer = new StaticRenderer({ verbose: false });

    renderer.markItemRunning("a");
    renderer.markItemCompleted("a");
    renderer.markItemRunning("b");
    renderer.markItemCompleted("b");

    const summary = renderer.formatSummary();
    assert(summary.startsWith("Completed:"), summary);
    assert(summary.includes("2 completed"), summary);
    assert(summary.match(/\(\d+s\)$/), `expected elapsed time, got: ${summary}`);
  });

  await t.step("Failed: some items failed", () => {
    const renderer = new StaticRenderer({ verbose: false });

    renderer.markItemRunning("a");
    renderer.markItemCompleted("a");
    renderer.markItemRunning("b");
    renderer.markItemFailed("b", "error");

    const summary = renderer.formatSummary();
    assert(summary.startsWith("Failed:"), summary);
    assert(summary.includes("1 completed"), summary);
    assert(summary.includes("1 failed"), summary);
  });

  await t.step("Aborted: run was interrupted", () => {
    const renderer = new StaticRenderer({ verbose: false });

    renderer.markItemRunning("a");
    renderer.markItemCompleted("a");
    renderer.setAborting();
    renderer.update("b", { type: "aborted" });

    const summary = renderer.formatSummary();
    assert(summary.startsWith("Aborted:"), summary);
    assert(summary.includes("1 completed"), summary);
    assert(summary.includes("1 aborted"), summary);
  });
});
