import { assertEquals } from "@std/assert";
import { CredentialError, isExpired } from "../../src/shared/auth/mod.ts";

Deno.test("CredentialError", async (t) => {
  await t.step("has correct name and message", () => {
    const err = new CredentialError("test message");
    assertEquals(err.name, "CredentialError");
    assertEquals(err.message, "test message");
  });

  await t.step("preserves cause", () => {
    const cause = new Error("inner");
    const err = new CredentialError("outer", cause);
    assertEquals(err.cause, cause);
  });
});

Deno.test("isExpired", async (t) => {
  await t.step("returns true for past timestamp", () => {
    const cred = {
      accessToken: "x",
      refreshToken: "y",
      expiresAt: 1000,
      scopes: [],
    };
    assertEquals(isExpired(cred), true);
  });

  await t.step("returns false for future timestamp", () => {
    const future = Date.now() + 3_600_000;
    const cred = {
      accessToken: "x",
      refreshToken: "y",
      expiresAt: future,
      scopes: [],
    };
    assertEquals(isExpired(cred), false);
  });

  await t.step("returns false when expiresAt is 0 (env var override)", () => {
    const cred = {
      accessToken: "x",
      refreshToken: "y",
      expiresAt: 0,
      scopes: [],
    };
    assertEquals(isExpired(cred), false);
  });
});
