import { assertEquals, assertStringIncludes } from "@std/assert";

Deno.test("CLI", async (t) => {
  await t.step("exits with code 2 when --task is missing", async () => {
    const cmd = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        "src/cli.ts",
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    assertEquals(result.code, 2);
    const stderr = new TextDecoder().decode(result.stderr);
    assertStringIncludes(stderr, "Usage:");
  });

  await t.step("exits with code 2 for invalid --max-loops", async () => {
    const cmd = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        "src/cli.ts",
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
});
