import { assertEquals, assertStringIncludes } from "@std/assert";

Deno.test("CLI", async (t) => {
  await t.step("exits with code 2 when no subcommand", async () => {
    const cmd = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        "src/cli/cli.ts",
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    assertEquals(result.code, 2);
    const stderr = new TextDecoder().decode(result.stderr);
    assertStringIncludes(stderr, "Usage: knox <command>");
  });

  await t.step("exits with code 2 for unknown subcommand", async () => {
    const cmd = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        "src/cli/cli.ts",
        "bogus",
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    assertEquals(result.code, 2);
    const stderr = new TextDecoder().decode(result.stderr);
    assertStringIncludes(stderr, "Unknown command: bogus");
  });

  await t.step("knox run without --task shows run usage", async () => {
    const cmd = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        "src/cli/cli.ts",
        "run",
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    assertEquals(result.code, 2);
    const stderr = new TextDecoder().decode(result.stderr);
    assertStringIncludes(stderr, "Usage: knox run --task");
  });

  await t.step("legacy --task flag works (implicit run)", async () => {
    const cmd = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        "src/cli/cli.ts",
        "--task",
        "test",
        "--max-loops",
        "abc",
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    assertEquals(result.code, 2);
    const stderr = new TextDecoder().decode(result.stderr);
    assertStringIncludes(stderr, "--max-loops must be a positive integer");
  });

  await t.step("knox run exits with code 2 for invalid --max-loops", async () => {
    const cmd = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        "src/cli/cli.ts",
        "run",
        "--task",
        "test",
        "--max-loops",
        "abc",
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    assertEquals(result.code, 2);
    const stderr = new TextDecoder().decode(result.stderr);
    assertStringIncludes(stderr, "--max-loops must be a positive integer");
  });

  await t.step("knox queue without --file shows error", async () => {
    const cmd = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        "src/cli/cli.ts",
        "queue",
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    assertEquals(result.code, 2);
    const stderr = new TextDecoder().decode(result.stderr);
    assertStringIncludes(stderr, "--file is required");
  });

  await t.step("knox queue with nonexistent file shows error", async () => {
    const cmd = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        "src/cli/cli.ts",
        "queue",
        "--file",
        "/tmp/nonexistent-knox-queue.json",
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    assertEquals(result.code, 2);
    const stderr = new TextDecoder().decode(result.stderr);
    assertStringIncludes(stderr, "queue file not found");
  });
});
