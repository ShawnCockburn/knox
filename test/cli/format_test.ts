import { assertEquals, assertStringIncludes } from "@std/assert";
import { formatDuration, formatSummary } from "../../src/cli/format.ts";
import { SinkStrategy } from "../../src/engine/sink/result_sink.ts";
import type { KnoxResult } from "../../src/engine/knox.ts";

function makeResult(overrides: Partial<KnoxResult> = {}): KnoxResult {
  return {
    runId: "a3f2b1c0",
    completed: true,
    aborted: false,
    loopsRun: 3,
    maxLoops: 10,
    startedAt: "2026-03-22T10:00:00.000Z",
    finishedAt: "2026-03-22T10:04:32.000Z",
    durationMs: 272000,
    provider: "claude",
    difficulty: "balanced",
    model: "sonnet",
    task: "Add MIT license",
    autoCommitted: false,
    checkPassed: true,
    sink: {
      strategy: SinkStrategy.HostGit,
      branchName: "knox/add-mit-licence-a3f2b1c0",
      commitCount: 2,
      autoCommitted: false,
    },
    ...overrides,
  };
}

Deno.test("formatDuration", async (t) => {
  await t.step("formats seconds only", () => {
    assertEquals(formatDuration(5000), "5s");
  });

  await t.step("formats minutes and seconds", () => {
    assertEquals(formatDuration(90000), "1m 30s");
  });

  await t.step("formats zero", () => {
    assertEquals(formatDuration(0), "0s");
  });

  await t.step("formats large duration", () => {
    assertEquals(formatDuration(272000), "4m 32s");
  });
});

Deno.test("formatSummary", async (t) => {
  await t.step("formats completed run", () => {
    const output = formatSummary(makeResult());
    assertStringIncludes(output, "completed (3/10 loops)");
    assertStringIncludes(output, "4m 32s");
    assertStringIncludes(output, "sonnet (balanced)");
    assertStringIncludes(output, "knox/add-mit-licence-a3f2b1c0");
    assertStringIncludes(output, "Commits:     2");
    assertStringIncludes(output, "Auto-commit: no");
    assertStringIncludes(output, "Check:       passed");
    assertStringIncludes(output, "Strategy:    host-git");
  });

  await t.step("formats stopped run", () => {
    const output = formatSummary(makeResult({
      completed: false,
      loopsRun: 10,
      maxLoops: 10,
    }));
    assertStringIncludes(output, "stopped (10/10 loops)");
  });

  await t.step("shows auto-commit: yes when autoCommitted", () => {
    const output = formatSummary(makeResult({ autoCommitted: true }));
    assertStringIncludes(output, "Auto-commit: yes");
  });

  await t.step("shows check: n/a when null", () => {
    const output = formatSummary(makeResult({ checkPassed: null }));
    assertStringIncludes(output, "Check:       n/a");
  });

  await t.step("shows check: failed", () => {
    const output = formatSummary(makeResult({ checkPassed: false }));
    assertStringIncludes(output, "Check:       failed");
  });

  await t.step("includes git commands in hints", () => {
    const output = formatSummary(makeResult());
    assertStringIncludes(
      output,
      "git log main..knox/add-mit-licence-a3f2b1c0",
    );
    assertStringIncludes(output, "git merge knox/add-mit-licence-a3f2b1c0");
  });
});
