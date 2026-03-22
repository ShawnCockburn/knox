import { assert, assertEquals } from "@std/assert";
import { resolveAuth } from "../../src/knox/resolve_auth.ts";

Deno.test("resolveAuth", async (t) => {
  await t.step("uses OAuth credential when env token is set", async () => {
    const origOAuth = Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN");
    const origKey = Deno.env.get("ANTHROPIC_API_KEY");

    Deno.env.set("CLAUDE_CODE_OAUTH_TOKEN", "oauth-test-token");
    Deno.env.delete("ANTHROPIC_API_KEY");

    try {
      const result = await resolveAuth(["EXISTING=value"]);
      // Base env preserved
      assertEquals(result.includes("EXISTING=value"), true);
      // OAuth token added
      const oauthVar = result.find((v) =>
        v.startsWith("CLAUDE_CODE_OAUTH_TOKEN=")
      );
      assertEquals(oauthVar, "CLAUDE_CODE_OAUTH_TOKEN=oauth-test-token");
    } finally {
      if (origOAuth) Deno.env.set("CLAUDE_CODE_OAUTH_TOKEN", origOAuth);
      else Deno.env.delete("CLAUDE_CODE_OAUTH_TOKEN");
      if (origKey) Deno.env.set("ANTHROPIC_API_KEY", origKey);
      else Deno.env.delete("ANTHROPIC_API_KEY");
    }
  });

  await t.step("preserves base env vars", async () => {
    const origOAuth = Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN");
    const origKey = Deno.env.get("ANTHROPIC_API_KEY");

    Deno.env.set("ANTHROPIC_API_KEY", "sk-test-key");

    try {
      const baseEnv = ["MY_VAR=hello", "OTHER=world"];
      const result = await resolveAuth(baseEnv);
      // Base env always preserved
      assertEquals(result.includes("MY_VAR=hello"), true);
      assertEquals(result.includes("OTHER=world"), true);
      // At least one auth env var should be added (OAuth or API key)
      assert(result.length >= 3, "Should add at least one auth var");
    } finally {
      if (origOAuth) Deno.env.set("CLAUDE_CODE_OAUTH_TOKEN", origOAuth);
      else Deno.env.delete("CLAUDE_CODE_OAUTH_TOKEN");
      if (origKey) Deno.env.set("ANTHROPIC_API_KEY", origKey);
      else Deno.env.delete("ANTHROPIC_API_KEY");
    }
  });

  await t.step("does not throw when no credential available", async () => {
    const origOAuth = Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN");
    const origKey = Deno.env.get("ANTHROPIC_API_KEY");

    Deno.env.delete("CLAUDE_CODE_OAUTH_TOKEN");
    Deno.env.delete("ANTHROPIC_API_KEY");

    try {
      // Should not throw — may or may not add credentials depending on platform store
      const result = await resolveAuth(["BASE=val"]);
      assertEquals(result.includes("BASE=val"), true);
    } finally {
      if (origOAuth) Deno.env.set("CLAUDE_CODE_OAUTH_TOKEN", origOAuth);
      else Deno.env.delete("CLAUDE_CODE_OAUTH_TOKEN");
      if (origKey) Deno.env.set("ANTHROPIC_API_KEY", origKey);
      else Deno.env.delete("ANTHROPIC_API_KEY");
    }
  });
});
