import { assertEquals, assertStringIncludes } from "@std/assert";
import { DockerRuntime } from "../../src/runtime/docker_runtime.ts";

const runtime = new DockerRuntime();

Deno.test("DockerRuntime", async (t) => {
  let containerId: string | undefined;

  await t.step("createContainer creates and starts a container", async () => {
    containerId = await runtime.createContainer({
      image: "ubuntu:latest",
      workdir: "/workspace",
    });
    assertStringIncludes(containerId, "knox-");
  });

  await t.step("exec runs a command and captures output", async () => {
    const result = await runtime.exec(containerId!, ["echo", "hello knox"]);
    assertEquals(result.exitCode, 0);
    assertStringIncludes(result.stdout, "hello knox");
  });

  await t.step("exec captures non-zero exit codes", async () => {
    const result = await runtime.exec(containerId!, [
      "sh",
      "-c",
      "exit 42",
    ]);
    assertEquals(result.exitCode, 42);
  });

  await t.step("exec respects workdir option", async () => {
    const result = await runtime.exec(containerId!, ["pwd"], {
      workdir: "/tmp",
    });
    assertEquals(result.stdout.trim(), "/tmp");
  });

  await t.step("execStream streams output line by line", async () => {
    const lines: { line: string; stream: "stdout" | "stderr" }[] = [];
    const exitCode = await runtime.execStream(
      containerId!,
      ["sh", "-c", 'echo "line1"; echo "line2"; echo "err1" >&2'],
      {
        onLine: (line, stream) => {
          lines.push({ line, stream });
        },
      },
    );
    assertEquals(exitCode, 0);
    // -t (PTY) merges stderr into stdout, so all lines arrive on stdout
    const stdoutLines = lines.filter((l) => l.stream === "stdout");
    assertEquals(stdoutLines.length, 3);
    assertEquals(stdoutLines[0].line, "line1");
    assertEquals(stdoutLines[1].line, "line2");
    assertEquals(stdoutLines[2].line, "err1");
  });

  await t.step("remove cleans up the container", async () => {
    await runtime.remove(containerId!);
    // Verify container is gone
    const result = await runtime.exec(containerId!, ["echo", "should fail"]);
    assertEquals(result.exitCode, 1);
    containerId = undefined;
  });
});
