import { assertEquals } from "@std/assert";
import {
  applyEvent,
  eventDescription,
  formatElapsed,
  initialDisplayState,
  markBlocked,
  markCompleted,
  markFailed,
  markRunning,
} from "../../../src/queue/tui/state.ts";
import type { KnoxEvent } from "../../../src/shared/types.ts";

Deno.test("TUI State Machine", async (t) => {
  await t.step("initialDisplayState returns pending with empty fields", () => {
    const state = initialDisplayState();
    assertEquals(state.status, "pending");
    assertEquals(state.phase, "");
    assertEquals(state.loop, 0);
    assertEquals(state.maxLoops, 0);
    assertEquals(state.startedAt, null);
    assertEquals(state.branch, null);
    assertEquals(state.error, null);
    assertEquals(state.blockedBy, null);
  });

  await t.step("container:created → running, 'setting up'", () => {
    const state = applyEvent(initialDisplayState(), {
      type: "container:created",
      containerId: "abc123",
    });
    assertEquals(state.status, "running");
    assertEquals(state.phase, "setting up");
    assertEquals(typeof state.startedAt, "number");
  });

  await t.step("loop:start → running, 'loop N/M'", () => {
    let state = initialDisplayState();
    state = applyEvent(state, {
      type: "container:created",
      containerId: "abc",
    });
    state = applyEvent(state, {
      type: "loop:start",
      loop: 2,
      maxLoops: 5,
    });
    assertEquals(state.status, "running");
    assertEquals(state.phase, "loop 2/5");
    assertEquals(state.loop, 2);
    assertEquals(state.maxLoops, 5);
  });

  await t.step("loop:end completed → 'agent complete'", () => {
    let state = initialDisplayState();
    state = applyEvent(state, {
      type: "container:created",
      containerId: "abc",
    });
    state = applyEvent(state, {
      type: "loop:start",
      loop: 1,
      maxLoops: 3,
    });
    state = applyEvent(state, {
      type: "loop:end",
      loop: 1,
      completed: true,
    });
    assertEquals(state.phase, "agent complete");
  });

  await t.step("loop:end not completed → 'loop N/M done'", () => {
    let state = initialDisplayState();
    state = applyEvent(state, {
      type: "container:created",
      containerId: "abc",
    });
    state = applyEvent(state, {
      type: "loop:start",
      loop: 2,
      maxLoops: 5,
    });
    state = applyEvent(state, {
      type: "loop:end",
      loop: 2,
      completed: false,
    });
    assertEquals(state.phase, "loop 2/5 done");
  });

  await t.step("check:failed → 'check failed, retrying'", () => {
    let state = initialDisplayState();
    state = applyEvent(state, {
      type: "container:created",
      containerId: "abc",
    });
    state = applyEvent(state, {
      type: "check:failed",
      loop: 1,
      output: "tests failed",
    });
    assertEquals(state.phase, "check failed, retrying");
  });

  await t.step("nudge:result → 'committing'", () => {
    let state = initialDisplayState();
    state = applyEvent(state, {
      type: "container:created",
      containerId: "abc",
    });
    state = applyEvent(state, { type: "nudge:result", committed: true });
    assertEquals(state.phase, "committing");
  });

  await t.step("bundle:extracted → 'extracting results'", () => {
    let state = initialDisplayState();
    state = applyEvent(state, {
      type: "container:created",
      containerId: "abc",
    });
    state = applyEvent(state, {
      type: "bundle:extracted",
      path: "/tmp/bundle",
    });
    assertEquals(state.phase, "extracting results");
  });

  await t.step("aborted → aborted status", () => {
    let state = initialDisplayState();
    state = applyEvent(state, {
      type: "container:created",
      containerId: "abc",
    });
    state = applyEvent(state, { type: "aborted" });
    assertEquals(state.status, "aborted");
    assertEquals(state.phase, "aborted");
  });

  await t.step("full lifecycle: pending → running → completed", () => {
    let state = initialDisplayState();
    state = markRunning(state);
    assertEquals(state.status, "running");
    assertEquals(state.phase, "starting");

    state = applyEvent(state, {
      type: "container:created",
      containerId: "abc",
    });
    assertEquals(state.phase, "setting up");

    state = applyEvent(state, {
      type: "loop:start",
      loop: 1,
      maxLoops: 3,
    });
    assertEquals(state.phase, "loop 1/3");

    state = applyEvent(state, {
      type: "loop:end",
      loop: 1,
      completed: true,
    });
    assertEquals(state.phase, "agent complete");

    state = applyEvent(state, {
      type: "bundle:extracted",
      path: "/tmp/b",
    });
    assertEquals(state.phase, "extracting results");

    state = markCompleted(state, "knox/feat-abc123");
    assertEquals(state.status, "completed");
    assertEquals(state.branch, "knox/feat-abc123");
  });

  await t.step("markFailed sets error", () => {
    let state = markRunning(initialDisplayState());
    state = markFailed(state, "Container crashed");
    assertEquals(state.status, "failed");
    assertEquals(state.error, "Container crashed");
  });

  await t.step("markBlocked sets blockedBy", () => {
    const state = markBlocked(initialDisplayState(), "item-a");
    assertEquals(state.status, "blocked");
    assertEquals(state.blockedBy, "item-a");
  });

  await t.step("container:created preserves existing startedAt", () => {
    let state = initialDisplayState();
    state = markRunning(state);
    const originalStart = state.startedAt;
    state = applyEvent(state, {
      type: "container:created",
      containerId: "abc",
    });
    assertEquals(state.startedAt, originalStart);
  });
});

Deno.test("eventDescription", async (t) => {
  const cases: Array<[KnoxEvent, string]> = [
    [{ type: "container:created", containerId: "abc" }, "container created"],
    [{ type: "loop:start", loop: 1, maxLoops: 5 }, "loop 1/5 started"],
    [
      { type: "loop:end", loop: 1, completed: true },
      "agent completed",
    ],
    [
      { type: "loop:end", loop: 2, completed: false },
      "loop 2 finished",
    ],
    [
      { type: "check:failed", loop: 1, output: "err" },
      "check failed (loop 1)",
    ],
    [
      { type: "nudge:result", committed: true },
      "committed changes",
    ],
    [
      { type: "nudge:result", committed: false },
      "nudge sent (no commit)",
    ],
    [
      { type: "bundle:extracted", path: "/tmp/b" },
      "bundle extracted",
    ],
    [{ type: "aborted" }, "aborted"],
  ];

  for (const [event, expected] of cases) {
    await t.step(`${event.type} → "${expected}"`, () => {
      assertEquals(eventDescription(event), expected);
    });
  }
});

Deno.test("formatElapsed", async (t) => {
  await t.step("null → empty string", () => {
    assertEquals(formatElapsed(null), "");
  });

  await t.step("recent timestamp → seconds", () => {
    const result = formatElapsed(Date.now() - 5000);
    assertEquals(result, "5s");
  });

  await t.step("older timestamp → minutes and seconds", () => {
    const result = formatElapsed(Date.now() - 125000);
    assertEquals(result, "2m 05s");
  });
});
