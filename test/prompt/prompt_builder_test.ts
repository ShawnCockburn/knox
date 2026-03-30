import { assertEquals, assertStringIncludes } from "@std/assert";
import { PromptBuilder } from "../../src/engine/prompt/prompt_builder.ts";
import {
  DEFAULT_PROMPT,
  SENTINEL_INSTRUCTION,
} from "../../src/engine/prompt/default_prompt.ts";

const builder = new PromptBuilder();

Deno.test("PromptBuilder", async (t) => {
  await t.step("includes default prompt when no custom prompt", () => {
    const result = builder.build({
      task: "Write a hello world script",
      loopNumber: 1,
      maxLoops: 10,
    });
    assertStringIncludes(result, DEFAULT_PROMPT);
  });

  await t.step("uses custom prompt when provided", () => {
    const custom = "You are a custom agent. Do the thing.";
    const result = builder.build({
      task: "Write a hello world script",
      loopNumber: 1,
      maxLoops: 10,
      customPrompt: custom,
    });
    assertStringIncludes(result, custom);
    assertEquals(result.includes(DEFAULT_PROMPT), false);
  });

  await t.step("includes task in prompt", () => {
    const result = builder.build({
      task: "Implement the FooBar feature",
      loopNumber: 1,
      maxLoops: 10,
    });
    assertStringIncludes(result, "=== TASK ===");
    assertStringIncludes(result, "Implement the FooBar feature");
  });

  await t.step("includes loop number and max loops", () => {
    const result = builder.build({
      task: "test",
      loopNumber: 3,
      maxLoops: 10,
    });
    assertStringIncludes(result, "=== LOOP ===");
    assertStringIncludes(result, "Loop 3 of 10");
  });

  await t.step("includes progress file content when present", () => {
    const progress =
      "## Loop 1\n- **Status**: partial\n- **What was done**: started work";
    const result = builder.build({
      task: "test",
      loopNumber: 2,
      maxLoops: 10,
      progressFileContent: progress,
    });
    assertStringIncludes(result, "=== PROGRESS (knox-progress.txt) ===");
    assertStringIncludes(result, progress);
  });

  await t.step("excludes progress section when not present", () => {
    const result = builder.build({
      task: "test",
      loopNumber: 1,
      maxLoops: 10,
    });
    assertEquals(result.includes("=== PROGRESS"), false);
  });

  await t.step("includes git log when present", () => {
    const gitLog = "abc1234 feat: initial setup\ndef5678 fix: typo";
    const result = builder.build({
      task: "test",
      loopNumber: 2,
      maxLoops: 10,
      gitLog,
    });
    assertStringIncludes(result, "=== GIT LOG (previous loops) ===");
    assertStringIncludes(result, gitLog);
  });

  await t.step("includes check failure when present", () => {
    const failure =
      "Error: test 'should add numbers' failed\nExpected 4 but got 5";
    const result = builder.build({
      task: "test",
      loopNumber: 3,
      maxLoops: 10,
      checkFailure: failure,
    });
    assertStringIncludes(result, "=== CHECK FAILURE (previous loop) ===");
    assertStringIncludes(result, failure);
    assertStringIncludes(result, "verification check failed");
  });

  await t.step("includes all sections together", () => {
    const result = builder.build({
      task: "Build the widget",
      loopNumber: 4,
      maxLoops: 10,
      progressFileContent: "progress data",
      gitLog: "abc feat: stuff",
      checkFailure: "tests broke",
    });
    assertStringIncludes(result, "=== TASK ===");
    assertStringIncludes(result, "=== LOOP ===");
    assertStringIncludes(result, "=== PROGRESS");
    assertStringIncludes(result, "=== GIT LOG");
    assertStringIncludes(result, "=== CHECK FAILURE");
  });

  await t.step("default prompt contains all 6 phases", () => {
    assertStringIncludes(DEFAULT_PROMPT, "Phase 1: READ");
    assertStringIncludes(DEFAULT_PROMPT, "Phase 2: EXPLORE");
    assertStringIncludes(DEFAULT_PROMPT, "Phase 3: PLAN");
    assertStringIncludes(DEFAULT_PROMPT, "Phase 4: EXECUTE");
    assertStringIncludes(DEFAULT_PROMPT, "Phase 5: COMMIT");
    assertStringIncludes(DEFAULT_PROMPT, "Phase 6: UPDATE");
  });

  await t.step("sentinel instruction contains KNOX_COMPLETE", () => {
    assertStringIncludes(SENTINEL_INSTRUCTION, "KNOX_COMPLETE");
  });

  await t.step("built prompt always includes sentinel instruction", () => {
    const result = builder.build({
      task: "test",
      loopNumber: 1,
      maxLoops: 10,
    });
    assertStringIncludes(result, "KNOX_COMPLETE");
  });

  await t.step("custom prompt includes sentinel instruction", () => {
    const result = builder.build({
      task: "test",
      loopNumber: 1,
      maxLoops: 10,
      customPrompt: "You are a custom agent.",
    });
    assertStringIncludes(result, "KNOX_COMPLETE");
    assertStringIncludes(result, "COMPLETION SIGNAL");
  });
});
