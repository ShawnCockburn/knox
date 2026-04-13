import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { resolveCodexHostAuth } from "../../src/provider/mod.ts";

function authJson(accessToken: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: accessToken,
      refresh_token: `refresh-${accessToken}`,
    },
  });
}

Deno.test("resolveCodexHostAuth", async (t) => {
  await t.step("uses CODEX_HOME auth.json when configured", async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "knox-codex-auth-" });
    const originalCodexHome = Deno.env.get("CODEX_HOME");
    const originalHome = Deno.env.get("HOME");

    try {
      await Deno.writeTextFile(join(tmpDir, "auth.json"), authJson("token-a"));
      Deno.env.set("CODEX_HOME", tmpDir);
      Deno.env.set("HOME", tmpDir);

      const resolved = await resolveCodexHostAuth();
      assertEquals(resolved.authFilePath, join(tmpDir, "auth.json"));
      assertEquals(resolved.authJson, authJson("token-a"));
    } finally {
      if (originalCodexHome) Deno.env.set("CODEX_HOME", originalCodexHome);
      else Deno.env.delete("CODEX_HOME");
      if (originalHome) Deno.env.set("HOME", originalHome);
      else Deno.env.delete("HOME");
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
  });

  await t.step("fails clearly when multiple auth files disagree", async () => {
    const rootDir = await Deno.makeTempDir({ prefix: "knox-codex-auth-" });
    const codexHome = join(rootDir, "explicit");
    const home = join(rootDir, "home");
    const defaultCodexHome = join(home, ".codex");
    const originalCodexHome = Deno.env.get("CODEX_HOME");
    const originalHome = Deno.env.get("HOME");

    try {
      await Deno.mkdir(codexHome, { recursive: true });
      await Deno.mkdir(defaultCodexHome, { recursive: true });
      await Deno.writeTextFile(join(codexHome, "auth.json"), authJson("one"));
      await Deno.writeTextFile(
        join(defaultCodexHome, "auth.json"),
        authJson("two"),
      );
      Deno.env.set("CODEX_HOME", codexHome);
      Deno.env.set("HOME", home);

      await assertRejects(
        () => resolveCodexHostAuth(),
        Error,
        "Multiple Codex auth sources were found and they disagree",
      );
    } finally {
      if (originalCodexHome) Deno.env.set("CODEX_HOME", originalCodexHome);
      else Deno.env.delete("CODEX_HOME");
      if (originalHome) Deno.env.set("HOME", originalHome);
      else Deno.env.delete("HOME");
      await Deno.remove(rootDir, { recursive: true }).catch(() => {});
    }
  });
});
