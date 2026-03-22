import { assertEquals } from "@std/assert";
import { getCredential } from "../../src/auth/mod.ts";

Deno.test("getCredential", async (t) => {
  await t.step(
    "returns credential from CLAUDE_CODE_OAUTH_TOKEN env var",
    async () => {
      const orig = Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN");
      Deno.env.set("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-test-token");
      try {
        const cred = await getCredential();
        assertEquals(cred.accessToken, "sk-ant-oat01-test-token");
        assertEquals(cred.refreshToken, "");
        assertEquals(cred.expiresAt, 0);
        assertEquals(cred.scopes, []);
      } finally {
        if (orig) Deno.env.set("CLAUDE_CODE_OAUTH_TOKEN", orig);
        else Deno.env.delete("CLAUDE_CODE_OAUTH_TOKEN");
      }
    },
  );

  await t.step("env var takes precedence over platform provider", async () => {
    const orig = Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN");
    Deno.env.set("CLAUDE_CODE_OAUTH_TOKEN", "env-takes-precedence");
    try {
      const cred = await getCredential();
      assertEquals(cred.accessToken, "env-takes-precedence");
    } finally {
      if (orig) Deno.env.set("CLAUDE_CODE_OAUTH_TOKEN", orig);
      else Deno.env.delete("CLAUDE_CODE_OAUTH_TOKEN");
    }
  });
});
