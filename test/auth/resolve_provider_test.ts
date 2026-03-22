import { assertEquals } from "@std/assert";
import {
  FileProvider,
  KeychainProvider,
  resolveProvider,
} from "../../src/auth/mod.ts";

Deno.test("resolveProvider", async (t) => {
  await t.step("returns correct provider for current platform", () => {
    const provider = resolveProvider();
    if (Deno.build.os === "darwin") {
      assertEquals(provider instanceof KeychainProvider, true);
    } else {
      assertEquals(provider instanceof FileProvider, true);
    }
  });
});
