import { assertEquals } from "@std/assert";
import { MockRuntime } from "./runtime/mock_runtime.ts";
import { Knox } from "../src/knox.ts";

Deno.test("Knox orchestrator", async (t) => {
  await t.step("wires modules together in correct order", async () => {
    const runtime = new MockRuntime();
    runtime.imageExistsResult = true; // base image cached

    // Setup exec results for the full flow
    let execCallCount = 0;
    runtime.exec = (container, command, options) => {
      runtime.calls.push({ method: "exec", args: [container, command, options] });
      execCallCount++;
      // Various exec calls during the flow: git init, git rev-parse HEAD,
      // mkdir .knox, cat progress, git log, etc.
      if (command.includes("rev-parse") && command.includes("HEAD")) {
        return Promise.resolve({ exitCode: 0, stdout: "abc123\n", stderr: "" });
      }
      if (command[0] === "git" && command[1] === "log") {
        if (command.includes("abc123..HEAD")) {
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        }
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };

    runtime.execStreamLines = [
      { line: "Working...", stream: "stdout" },
      { line: "KNOX_COMPLETE", stream: "stdout" },
    ];

    const origKey = Deno.env.get("ANTHROPIC_API_KEY");
    Deno.env.set("ANTHROPIC_API_KEY", "test-key");

    try {
      const knox = new Knox({
        task: "Test task",
        dir: Deno.cwd(),
        maxLoops: 1,
        model: "sonnet",
        runtime,
        skipPreflight: true,
        onLine: () => {},
      });

      const result = await knox.run();

      assertEquals(result.completed, true);
      assertEquals(result.loopsRun, 1);

      // Verify the orchestration order
      const methods = runtime.calls.map((c) => c.method);
      // Should see: imageExists, createContainer, copyIn, exec(s)..., execStream, remove
      assertEquals(methods.includes("imageExists"), true);
      assertEquals(methods.includes("createContainer"), true);
      assertEquals(methods.includes("copyIn"), true);
      assertEquals(methods.includes("execStream"), true);
      // remove should be the last call (cleanup)
      assertEquals(methods[methods.length - 1], "remove");
    } finally {
      if (origKey) Deno.env.set("ANTHROPIC_API_KEY", origKey);
      else Deno.env.delete("ANTHROPIC_API_KEY");
    }
  });
});
