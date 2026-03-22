import { assert, assertRejects } from "@std/assert";
import { resolveAllowedIPs } from "../../src/knox/resolve_network.ts";

Deno.test("resolveAllowedIPs", async (t) => {
  await t.step("resolves DNS for API hosts", async () => {
    // This test requires network access — it hits real DNS
    const ips = await resolveAllowedIPs();

    assert(ips.length > 0, "Should resolve at least one IP");
    for (const ip of ips) {
      assert(
        /^\d+\.\d+\.\d+\.\d+$/.test(ip),
        `Each result should be an IPv4 address, got: ${ip}`,
      );
    }
  });
});
