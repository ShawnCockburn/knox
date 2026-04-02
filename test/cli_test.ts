import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, resolve } from "@std/path";

const PROJECT_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const CLI_PATH = resolve(PROJECT_ROOT, "src/cli/cli.ts");

Deno.test("CLI", async (t) => {
  await t.step("exits with code 2 when no subcommand", async () => {
    const cmd = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        CLI_PATH,
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
        CLI_PATH,
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
        CLI_PATH,
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
        CLI_PATH,
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

  await t.step(
    "knox run exits with code 2 for invalid --max-loops",
    async () => {
      const cmd = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-env",
          CLI_PATH,
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
    },
  );

  await t.step(
    "knox run exits with code 2 for invalid --difficulty",
    async () => {
      const cmd = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-env",
          CLI_PATH,
          "run",
          "--task",
          "test",
          "--difficulty",
          "hard",
        ],
        stdout: "piped",
        stderr: "piped",
      });
      const result = await cmd.output();
      assertEquals(result.code, 2);
      const stderr = new TextDecoder().decode(result.stderr);
      assertStringIncludes(
        stderr,
        "--difficulty must be one of: complex, balanced, easy",
      );
    },
  );

  // ── queue --file mode ────────────────────────────────────────────────────

  await t.step(
    "knox queue without --source shows migration error",
    async () => {
      const cmd = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-env",
          CLI_PATH,
          "queue",
        ],
        stdout: "piped",
        stderr: "piped",
      });
      const result = await cmd.output();
      assertEquals(result.code, 2);
      const stderr = new TextDecoder().decode(result.stderr);
      assertStringIncludes(stderr, "--source is required");
    },
  );

  await t.step(
    "knox queue --file with nonexistent file shows error",
    async () => {
      const cmd = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-env",
          CLI_PATH,
          "queue",
          "--source",
          "directory",
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
    },
  );

  // ── queue discovery mode ─────────────────────────────────────────────────

  await t.step(
    "knox queue --source directory (no args) errors when no queues found in .knox/queues/",
    async () => {
      // Run from /tmp so there is no .knox/queues/ directory
      const cmd = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-env",
          CLI_PATH,
          "queue",
          "--source",
          "directory",
        ],
        stdout: "piped",
        stderr: "piped",
        cwd: "/tmp",
      });
      const result = await cmd.output();
      assertEquals(result.code, 2);
      const stderr = new TextDecoder().decode(result.stderr);
      assertStringIncludes(stderr, "no queues found");
    },
  );

  await t.step(
    "knox queue --source directory (no args) discovers queues in .knox/queues/",
    async () => {
      // Create a temp dir with a valid queue under .knox/queues/
      const tmpDir = await Deno.makeTempDir();
      try {
        const queueDir = `${tmpDir}/.knox/queues/my-queue`;
        await Deno.mkdir(queueDir, { recursive: true });
        await Deno.writeTextFile(
          `${queueDir}/task-1.md`,
          `echo hello`,
        );

        // Run CLI — it will fail at the docker/image stage but must get past
        // the "no queues found" check.
        const cmd = new Deno.Command("deno", {
          args: [
            "run",
            "--allow-read",
            "--allow-env",
            CLI_PATH,
            "queue",
            "--source",
            "directory",
          ],
          stdout: "piped",
          stderr: "piped",
          cwd: tmpDir,
        });
        const result = await cmd.output();
        const stderr = new TextDecoder().decode(result.stderr);
        // Should NOT print "no queues found" — discovery succeeded
        assertEquals(
          stderr.includes("no queues found"),
          false,
          `Expected no "no queues found" in stderr, got: ${stderr}`,
        );
        // Should mention the discovered queue by printing "Discovered" or
        // proceeding to resolve resources
        const passed = stderr.includes("Discovered") ||
          stderr.includes("Resolving") ||
          result.code !== 2;
        assertEquals(passed, true, `stderr: ${stderr}`);
      } finally {
        await Deno.remove(tmpDir, { recursive: true });
      }
    },
  );

  // ── queue --name mode ────────────────────────────────────────────────────

  await t.step(
    "knox queue --source directory --name errors when named queue does not exist",
    async () => {
      const cmd = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-env",
          CLI_PATH,
          "queue",
          "--source",
          "directory",
          "--name",
          "nonexistent-queue",
        ],
        stdout: "piped",
        stderr: "piped",
        cwd: "/tmp",
      });
      const result = await cmd.output();
      assertEquals(result.code, 2);
      const stderr = new TextDecoder().decode(result.stderr);
      assertStringIncludes(stderr, "queue not found");
    },
  );

  await t.step(
    "knox queue --source directory --name finds existing named queue",
    async () => {
      const tmpDir = await Deno.makeTempDir();
      try {
        const queueDir = `${tmpDir}/.knox/queues/my-queue`;
        await Deno.mkdir(queueDir, { recursive: true });
        await Deno.writeTextFile(
          `${queueDir}/task-1.md`,
          `echo hello`,
        );

        const cmd = new Deno.Command("deno", {
          args: [
            "run",
            "--allow-read",
            "--allow-env",
            CLI_PATH,
            "queue",
            "--source",
            "directory",
            "--name",
            "my-queue",
          ],
          stdout: "piped",
          stderr: "piped",
          cwd: tmpDir,
        });
        const result = await cmd.output();
        const stderr = new TextDecoder().decode(result.stderr);
        // Should NOT print "queue not found"
        assertEquals(
          stderr.includes("queue not found"),
          false,
          `stderr: ${stderr}`,
        );
      } finally {
        await Deno.remove(tmpDir, { recursive: true });
      }
    },
  );

  // ── --output flag ────────────────────────────────────────────────────────

  await t.step(
    "knox queue --source directory --output pr is accepted (does not cause early exit-2)",
    async () => {
      // Run from /tmp where there is no .knox/queues — discovery fails with
      // exit 2 due to "no queues found", NOT due to bad --output flag.
      const cmd = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-env",
          CLI_PATH,
          "queue",
          "--source",
          "directory",
          "--output",
          "pr",
        ],
        stdout: "piped",
        stderr: "piped",
        cwd: "/tmp",
      });
      const result = await cmd.output();
      assertEquals(result.code, 2);
      const stderr = new TextDecoder().decode(result.stderr);
      // Error must be about "no queues found", not about --output being invalid
      assertStringIncludes(stderr, "no queues found");
    },
  );

  await t.step(
    "knox run --output pr is accepted (does not cause early exit-2)",
    async () => {
      // Without --task it should print usage, not error about --output
      const cmd = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-read",
          "--allow-env",
          CLI_PATH,
          "run",
          "--output",
          "pr",
        ],
        stdout: "piped",
        stderr: "piped",
      });
      const result = await cmd.output();
      assertEquals(result.code, 2);
      const stderr = new TextDecoder().decode(result.stderr);
      assertStringIncludes(stderr, "Usage: knox run --task");
    },
  );

  // ── config loading ───────────────────────────────────────────────────────

  await t.step(
    "knox queue --source directory reads .knox/config.yaml output strategy",
    async () => {
      const tmpDir = await Deno.makeTempDir();
      try {
        // Write a config with output: pr
        await Deno.mkdir(`${tmpDir}/.knox`, { recursive: true });
        await Deno.writeTextFile(
          `${tmpDir}/.knox/config.yaml`,
          `output: pr\n`,
        );
        // No queues — should fail with "no queues found" not a config error
        const cmd = new Deno.Command("deno", {
          args: [
            "run",
            "--allow-read",
            "--allow-env",
            CLI_PATH,
            "queue",
            "--source",
            "directory",
          ],
          stdout: "piped",
          stderr: "piped",
          cwd: tmpDir,
        });
        const result = await cmd.output();
        assertEquals(result.code, 2);
        const stderr = new TextDecoder().decode(result.stderr);
        // Config was loaded fine; error is about missing queues
        assertStringIncludes(stderr, "no queues found");
      } finally {
        await Deno.remove(tmpDir, { recursive: true });
      }
    },
  );

  // ── queue --help ─────────────────────────────────────────────────────────

  await t.step("knox queue --help shows queue usage", async () => {
    const cmd = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        CLI_PATH,
        "queue",
        "--help",
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    assertEquals(result.code, 0);
    const stderr = new TextDecoder().decode(result.stderr);
    assertStringIncludes(stderr, "Usage: knox queue");
    assertStringIncludes(stderr, "--name");
    assertStringIncludes(stderr, "--output");
  });
});
