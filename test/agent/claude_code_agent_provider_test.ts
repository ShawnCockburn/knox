import { assertEquals, assertStringIncludes } from "@std/assert";
import { ClaudeCodeAgentProvider } from "../../src/engine/agent/claude_code_agent_provider.ts";
import type {
  AgentContext,
  ContainerHandle,
} from "../../src/engine/agent/agent_provider.ts";
import type { ExecResult } from "../../src/shared/types.ts";
import type {
  ExecOptions,
  OnLineCallback,
} from "../../src/shared/runtime/container_runtime.ts";
import {
  DEFAULT_PROMPT,
  SENTINEL_INSTRUCTION,
} from "../../src/engine/prompt/default_prompt.ts";

// ---------------------------------------------------------------------------
// Mock ContainerHandle
// ---------------------------------------------------------------------------

interface MockExecCall {
  command: string[];
  options?: ExecOptions;
}

interface MockStreamCall {
  command: string[];
}

class MockContainerHandle implements ContainerHandle {
  execCalls: MockExecCall[] = [];
  streamCalls: MockStreamCall[] = [];
  copyInCalls: { hostPath: string; containerPath: string }[] = [];

  execHandler?: (
    command: string[],
    options?: ExecOptions,
  ) => Promise<ExecResult>;

  streamLines: { line: string; stream: "stdout" | "stderr" }[] = [];
  streamExitCode = 0;

  exec(command: string[], options?: ExecOptions): Promise<ExecResult> {
    this.execCalls.push({ command, options });
    if (this.execHandler) return this.execHandler(command, options);
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  }

  execStream(
    command: string[],
    options: ExecOptions & { onLine: OnLineCallback },
  ): Promise<number> {
    this.streamCalls.push({ command });
    for (const { line, stream } of this.streamLines) {
      options.onLine(line, stream);
    }
    return Promise.resolve(this.streamExitCode);
  }

  copyIn(hostPath: string, containerPath: string): Promise<void> {
    this.copyInCalls.push({ hostPath, containerPath });
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(
  container: MockContainerHandle,
  overrides: Partial<AgentContext> = {},
): AgentContext {
  return {
    container,
    task: "Implement feature X",
    loopNumber: 1,
    maxLoops: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("ClaudeCodeAgentProvider", async (t) => {
  await t.step(
    "builds prompt with task, loop context, and default prompt",
    async () => {
      const container = new MockContainerHandle();
      container.streamLines = [{ line: "working...", stream: "stdout" }];

      // Track prompt content via copyIn
      let promptContent = "";
      const origCopyIn = container.copyIn.bind(container);
      container.copyIn = async (hostPath: string, containerPath: string) => {
        promptContent = await Deno.readTextFile(hostPath);
        return origCopyIn(hostPath, containerPath);
      };

      const provider = new ClaudeCodeAgentProvider("sonnet");
      await provider.invoke(makeContext(container));

      assertStringIncludes(promptContent, DEFAULT_PROMPT);
      assertStringIncludes(promptContent, SENTINEL_INSTRUCTION);
      assertStringIncludes(promptContent, "=== TASK ===");
      assertStringIncludes(promptContent, "Implement feature X");
      assertStringIncludes(promptContent, "Loop 1 of 10");
    },
  );

  await t.step("includes progress file content in prompt", async () => {
    const container = new MockContainerHandle();
    container.streamLines = [{ line: "ok", stream: "stdout" }];
    container.execHandler = (command) => {
      if (command[0] === "cat" && command[1] === "knox-progress.txt") {
        return Promise.resolve({
          exitCode: 0,
          stdout: "## Loop 1\n- Did stuff",
          stderr: "",
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };

    let promptContent = "";
    const origCopyIn = container.copyIn.bind(container);
    container.copyIn = async (hostPath: string, containerPath: string) => {
      promptContent = await Deno.readTextFile(hostPath);
      return origCopyIn(hostPath, containerPath);
    };

    const provider = new ClaudeCodeAgentProvider("sonnet");
    await provider.invoke(makeContext(container));

    assertStringIncludes(promptContent, "=== PROGRESS (knox-progress.txt) ===");
    assertStringIncludes(promptContent, "## Loop 1\n- Did stuff");
  });

  await t.step("includes git log in prompt", async () => {
    const container = new MockContainerHandle();
    container.streamLines = [{ line: "ok", stream: "stdout" }];
    container.execHandler = (command) => {
      if (command[0] === "git" && command[1] === "log") {
        return Promise.resolve({
          exitCode: 0,
          stdout: "abc123 feat: initial\n",
          stderr: "",
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };

    let promptContent = "";
    const origCopyIn = container.copyIn.bind(container);
    container.copyIn = async (hostPath: string, containerPath: string) => {
      promptContent = await Deno.readTextFile(hostPath);
      return origCopyIn(hostPath, containerPath);
    };

    const provider = new ClaudeCodeAgentProvider("sonnet");
    await provider.invoke(makeContext(container));

    assertStringIncludes(promptContent, "=== GIT LOG (previous loops) ===");
    assertStringIncludes(promptContent, "abc123 feat: initial");
  });

  await t.step("includes check failure in prompt", async () => {
    const container = new MockContainerHandle();
    container.streamLines = [{ line: "ok", stream: "stdout" }];

    let promptContent = "";
    const origCopyIn = container.copyIn.bind(container);
    container.copyIn = async (hostPath: string, containerPath: string) => {
      promptContent = await Deno.readTextFile(hostPath);
      return origCopyIn(hostPath, containerPath);
    };

    const provider = new ClaudeCodeAgentProvider("sonnet");
    await provider.invoke(
      makeContext(container, { checkFailure: "Error: tests broke" }),
    );

    assertStringIncludes(
      promptContent,
      "=== CHECK FAILURE (previous loop) ===",
    );
    assertStringIncludes(promptContent, "Error: tests broke");
  });

  await t.step("uses custom prompt instead of default", async () => {
    const container = new MockContainerHandle();
    container.streamLines = [{ line: "ok", stream: "stdout" }];

    let promptContent = "";
    const origCopyIn = container.copyIn.bind(container);
    container.copyIn = async (hostPath: string, containerPath: string) => {
      promptContent = await Deno.readTextFile(hostPath);
      return origCopyIn(hostPath, containerPath);
    };

    const provider = new ClaudeCodeAgentProvider("sonnet");
    await provider.invoke(
      makeContext(container, { customPrompt: "You are a custom agent." }),
    );

    assertStringIncludes(promptContent, "You are a custom agent.");
    assertEquals(promptContent.includes(DEFAULT_PROMPT), false);
    // Sentinel instruction still present
    assertStringIncludes(promptContent, "KNOX_COMPLETE");
  });

  await t.step(
    "sentinel detection: returns completed=true when sentinel appears",
    async () => {
      const container = new MockContainerHandle();
      container.streamLines = [
        { line: "Working on it...", stream: "stdout" },
        { line: "KNOX_COMPLETE", stream: "stdout" },
      ];

      const provider = new ClaudeCodeAgentProvider("sonnet");
      const result = await provider.invoke(makeContext(container));

      assertEquals(result.completed, true);
    },
  );

  await t.step(
    "sentinel detection: returns completed=false when sentinel absent",
    async () => {
      const container = new MockContainerHandle();
      container.streamLines = [
        { line: "Still working...", stream: "stdout" },
      ];

      const provider = new ClaudeCodeAgentProvider("sonnet");
      const result = await provider.invoke(makeContext(container));

      assertEquals(result.completed, false);
    },
  );

  await t.step(
    "prompt file is written to expected container path",
    async () => {
      const container = new MockContainerHandle();
      container.streamLines = [{ line: "ok", stream: "stdout" }];

      const provider = new ClaudeCodeAgentProvider("sonnet");
      await provider.invoke(makeContext(container));

      assertEquals(container.copyInCalls.length, 1);
      assertEquals(
        container.copyInCalls[0].containerPath,
        "/workspace/.knox/prompt.txt",
      );
    },
  );

  await t.step("model and CLI flags are passed correctly", async () => {
    const container = new MockContainerHandle();
    container.streamLines = [{ line: "ok", stream: "stdout" }];

    const provider = new ClaudeCodeAgentProvider("opus");
    await provider.invoke(makeContext(container));

    assertEquals(container.streamCalls.length, 1);
    const cmd = container.streamCalls[0].command;
    assertEquals(cmd[0], "sh");
    assertEquals(cmd[1], "-c");
    assertStringIncludes(cmd[2], "/opt/claude/bin/claude");
    assertStringIncludes(cmd[2], "-p");
    assertStringIncludes(cmd[2], "--dangerously-skip-permissions");
    assertStringIncludes(cmd[2], "--model opus");
  });

  await t.step("handles missing progress file gracefully", async () => {
    const container = new MockContainerHandle();
    container.streamLines = [{ line: "ok", stream: "stdout" }];
    container.execHandler = (command) => {
      if (command[0] === "cat" && command[1] === "knox-progress.txt") {
        return Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr: "No such file",
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };

    let promptContent = "";
    const origCopyIn = container.copyIn.bind(container);
    container.copyIn = async (hostPath: string, containerPath: string) => {
      promptContent = await Deno.readTextFile(hostPath);
      return origCopyIn(hostPath, containerPath);
    };

    const provider = new ClaudeCodeAgentProvider("sonnet");
    const result = await provider.invoke(makeContext(container));

    // Should not error
    assertEquals(result.exitCode, 0);
    // Prompt should not contain progress section
    assertEquals(promptContent.includes("=== PROGRESS"), false);
  });

  await t.step("returns exit code from execStream", async () => {
    const container = new MockContainerHandle();
    container.streamLines = [{ line: "error!", stream: "stderr" }];
    container.streamExitCode = 1;

    const provider = new ClaudeCodeAgentProvider("sonnet");
    const result = await provider.invoke(makeContext(container));

    assertEquals(result.exitCode, 1);
    assertEquals(result.completed, false);
  });

  await t.step("streams stdout to onLine callback", async () => {
    const container = new MockContainerHandle();
    container.streamLines = [
      { line: "line-one", stream: "stdout" },
      { line: "line-two", stream: "stdout" },
    ];

    const lines: string[] = [];
    const provider = new ClaudeCodeAgentProvider("sonnet");
    await provider.invoke(
      makeContext(container, { onLine: (line) => lines.push(line) }),
    );

    assertEquals(lines, ["line-one", "line-two"]);
  });

  await t.step("streams stderr with prefix to onLine callback", async () => {
    const container = new MockContainerHandle();
    container.streamLines = [
      { line: "warning", stream: "stderr" },
    ];

    const lines: string[] = [];
    const provider = new ClaudeCodeAgentProvider("sonnet");
    await provider.invoke(
      makeContext(container, { onLine: (line) => lines.push(line) }),
    );

    assertEquals(lines, ["[stderr] warning"]);
  });
});
