import { assertEquals, assertStringIncludes } from "@std/assert";
import { CodexAgentProvider } from "../../src/engine/agent/codex_agent_provider.ts";
import type {
  ContainerHandle,
  LlmAgentContext,
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

class MockContainerHandle implements ContainerHandle {
  execCalls: Array<{ command: string[]; options?: ExecOptions }> = [];
  streamCalls: Array<{ command: string[]; options?: ExecOptions }> = [];
  copyInCalls: Array<{ hostPath: string; containerPath: string }> = [];
  execHandler?: (
    command: string[],
    options?: ExecOptions,
  ) => Promise<ExecResult>;
  streamLines: Array<{ line: string; stream: "stdout" | "stderr" }> = [];
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
    this.streamCalls.push({ command, options });
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

function makeContext(
  container: MockContainerHandle,
  overrides: Partial<LlmAgentContext> = {},
): LlmAgentContext {
  return {
    container,
    task: "Implement feature X",
    loopNumber: 1,
    maxLoops: 10,
    ...overrides,
  };
}

Deno.test("CodexAgentProvider", async (t) => {
  await t.step("builds prompt with default Knox context", async () => {
    const container = new MockContainerHandle();
    container.streamLines = [{ line: "working...", stream: "stdout" }];

    let promptContent = "";
    container.copyIn = async (hostPath: string, containerPath: string) => {
      promptContent = await Deno.readTextFile(hostPath);
      container.copyInCalls.push({ hostPath, containerPath });
    };

    const provider = new CodexAgentProvider("gpt-5.4", {
      codexHome: "/tmp/codex-home",
    });
    await provider.invoke(makeContext(container));

    assertStringIncludes(promptContent, DEFAULT_PROMPT);
    assertStringIncludes(promptContent, SENTINEL_INSTRUCTION);
    assertStringIncludes(promptContent, "Implement feature X");
    assertEquals(
      container.copyInCalls[0].containerPath,
      "/workspace/.knox/prompt.txt",
    );
  });

  await t.step(
    "passes CODEX_HOME and detects sentinel completion",
    async () => {
      const container = new MockContainerHandle();
      container.streamLines = [
        { line: "Working...", stream: "stdout" },
        { line: "KNOX_COMPLETE", stream: "stdout" },
      ];

      const provider = new CodexAgentProvider("gpt-5.4", {
        codexHome: "/tmp/codex-home",
      });
      const result = await provider.invoke(makeContext(container));

      assertEquals(result.completed, true);
      assertEquals(container.streamCalls.length, 1);
      const streamCall = container.streamCalls[0];
      assertStringIncludes(
        streamCall.command.join(" "),
        "/opt/codex/bin/codex",
      );
      assertEquals(streamCall.options?.env, [
        "CODEX_HOME=/tmp/codex-home",
        "HOME=/tmp/knox-home",
      ]);
    },
  );
});
