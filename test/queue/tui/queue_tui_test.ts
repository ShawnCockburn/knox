import { assertEquals } from "@std/assert";
import {
  applyEvent,
  initialDisplayState,
  markBlocked,
  markCompleted,
  markFailed,
  markRunning,
  SPINNER_FRAMES,
  STATUS_ICONS,
} from "../../../src/queue/tui/state.ts";
import type {
  DisplayStatus,
  ItemDisplayState,
} from "../../../src/queue/tui/state.ts";
import type { KnoxEvent } from "../../../src/shared/types.ts";

Deno.test("State machine: all event sequences", async (t) => {
  await t.step("multi-loop with check failures", () => {
    let state = markRunning(initialDisplayState());
    assertEquals(state.status, "running");

    state = applyEvent(state, {
      type: "container:created",
      containerId: "c1",
    });
    assertEquals(state.phase, "setting up");

    // Loop 1: check fails
    state = applyEvent(state, { type: "loop:start", loop: 1, maxLoops: 5 });
    assertEquals(state.phase, "loop 1/5");
    state = applyEvent(state, {
      type: "check:failed",
      loop: 1,
      output: "test fail",
    });
    assertEquals(state.phase, "check failed, retrying");
    state = applyEvent(state, { type: "nudge:result", committed: true });
    assertEquals(state.phase, "committing");
    state = applyEvent(state, { type: "loop:end", loop: 1, completed: false });
    assertEquals(state.phase, "loop 1/5 done");

    // Loop 2: succeeds
    state = applyEvent(state, { type: "loop:start", loop: 2, maxLoops: 5 });
    assertEquals(state.phase, "loop 2/5");
    assertEquals(state.loop, 2);
    state = applyEvent(state, { type: "loop:end", loop: 2, completed: true });
    assertEquals(state.phase, "agent complete");

    state = applyEvent(state, {
      type: "bundle:extracted",
      path: "/tmp/b",
    });
    assertEquals(state.phase, "extracting results");

    state = markCompleted(state, "knox/feature-abc");
    assertEquals(state.status, "completed");
    assertEquals(state.branch, "knox/feature-abc");
  });

  await t.step("abort during loop", () => {
    let state = markRunning(initialDisplayState());
    state = applyEvent(state, {
      type: "container:created",
      containerId: "c1",
    });
    state = applyEvent(state, { type: "loop:start", loop: 1, maxLoops: 3 });
    state = applyEvent(state, { type: "aborted" });
    assertEquals(state.status, "aborted");
    assertEquals(state.phase, "aborted");
    // loop/maxLoops preserved
    assertEquals(state.loop, 1);
    assertEquals(state.maxLoops, 3);
  });

  await t.step("failure preserves timing", () => {
    let state = markRunning(initialDisplayState());
    const startedAt = state.startedAt;
    state = applyEvent(state, {
      type: "container:created",
      containerId: "c1",
    });
    state = markFailed(state, "container OOM");
    assertEquals(state.status, "failed");
    assertEquals(state.error, "container OOM");
    assertEquals(state.startedAt, startedAt);
  });

  await t.step("blocked item never ran", () => {
    const state = markBlocked(initialDisplayState(), "dep-item");
    assertEquals(state.status, "blocked");
    assertEquals(state.blockedBy, "dep-item");
    assertEquals(state.startedAt, null);
  });
});

Deno.test("Status icons cover all statuses", () => {
  const allStatuses: DisplayStatus[] = [
    "pending",
    "running",
    "completed",
    "failed",
    "aborted",
    "blocked",
  ];
  for (const status of allStatuses) {
    assertEquals(typeof STATUS_ICONS[status], "string");
  }
});

Deno.test("Spinner frames are 10 braille characters", () => {
  assertEquals(SPINNER_FRAMES.length, 10);
  for (const frame of SPINNER_FRAMES) {
    assertEquals(frame.length, 1);
  }
});
