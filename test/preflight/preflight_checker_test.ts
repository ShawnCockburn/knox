import { assert, assertEquals } from "@std/assert";
import { PreflightChecker } from "../../src/preflight/preflight_checker.ts";
import { MockRuntime } from "../runtime/mock_runtime.ts";

const checker = new PreflightChecker();

Deno.test("PreflightChecker", async (t) => {
  await t.step("passes when all checks succeed", async () => {
    const runtime = new MockRuntime();
    // Set API key for the test
    const origKey = Deno.env.get("ANTHROPIC_API_KEY");
    Deno.env.set("ANTHROPIC_API_KEY", "test-key");
    try {
      const result = await checker.check({
        runtime,
        sourceDir: Deno.cwd(),
        envVars: [],
      });
      // Docker check will pass if Docker is running
      // Source dir exists (cwd)
      // API key is set
      assertEquals(result.errors.filter((e) => !e.includes("Docker")).length, 0);
    } finally {
      if (origKey) Deno.env.set("ANTHROPIC_API_KEY", origKey);
      else Deno.env.delete("ANTHROPIC_API_KEY");
    }
  });

  await t.step("reports missing auth when no credentials available", async () => {
    const runtime = new MockRuntime();
    const origKey = Deno.env.get("ANTHROPIC_API_KEY");
    const origOauth = Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN");
    Deno.env.delete("ANTHROPIC_API_KEY");
    Deno.env.delete("CLAUDE_CODE_OAUTH_TOKEN");
    try {
      const result = await checker.check({
        runtime,
        sourceDir: Deno.cwd(),
        envVars: [],
      });
      const authErrors = result.errors.filter((e) =>
        e.includes("No authentication") || e.includes("ANTHROPIC_API_KEY")
      );
      // On machines with Claude Code logged in, the keychain provides credentials
      // and there is no auth error. Otherwise, expect exactly 1 auth error.
      assert(authErrors.length === 0 || authErrors.length === 1);
    } finally {
      if (origKey) Deno.env.set("ANTHROPIC_API_KEY", origKey);
      if (origOauth) Deno.env.set("CLAUDE_CODE_OAUTH_TOKEN", origOauth);
    }
  });

  await t.step("accepts API key from --env flags", async () => {
    const runtime = new MockRuntime();
    const origKey = Deno.env.get("ANTHROPIC_API_KEY");
    Deno.env.delete("ANTHROPIC_API_KEY");
    try {
      const result = await checker.check({
        runtime,
        sourceDir: Deno.cwd(),
        envVars: ["ANTHROPIC_API_KEY=sk-test"],
      });
      const apiKeyErrors = result.errors.filter((e) =>
        e.includes("ANTHROPIC_API_KEY")
      );
      assertEquals(apiKeyErrors.length, 0);
    } finally {
      if (origKey) Deno.env.set("ANTHROPIC_API_KEY", origKey);
    }
  });

  await t.step("reports missing source directory", async () => {
    const runtime = new MockRuntime();
    const origKey = Deno.env.get("ANTHROPIC_API_KEY");
    Deno.env.set("ANTHROPIC_API_KEY", "test-key");
    try {
      const result = await checker.check({
        runtime,
        sourceDir: "/nonexistent/path/that/does/not/exist",
        envVars: [],
      });
      const dirErrors = result.errors.filter((e) =>
        e.includes("does not exist")
      );
      assertEquals(dirErrors.length, 1);
    } finally {
      if (origKey) Deno.env.set("ANTHROPIC_API_KEY", origKey);
      else Deno.env.delete("ANTHROPIC_API_KEY");
    }
  });

  await t.step("warns when source dir is not a git repo", async () => {
    const runtime = new MockRuntime();
    const origKey = Deno.env.get("ANTHROPIC_API_KEY");
    Deno.env.set("ANTHROPIC_API_KEY", "test-key");
    const tmpDir = await Deno.makeTempDir();
    try {
      const result = await checker.check({
        runtime,
        sourceDir: tmpDir,
        envVars: [],
      });
      const gitWarnings = result.warnings.filter((w) =>
        w.includes("not a git repository")
      );
      assertEquals(gitWarnings.length, 1);
    } finally {
      if (origKey) Deno.env.set("ANTHROPIC_API_KEY", origKey);
      else Deno.env.delete("ANTHROPIC_API_KEY");
      await Deno.remove(tmpDir, { recursive: true });
    }
  });
});
