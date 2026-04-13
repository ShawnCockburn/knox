import { assert, assertStringIncludes } from "@std/assert";
import {
  CLAUDE_REQUIRED_HOSTS,
  resolveAllowedIPsForHosts,
} from "../../src/shared/knox/resolve_network.ts";

Deno.test("resolveAllowedIPs", async (t) => {
  await t.step("resolves DNS for API hosts", async () => {
    try {
      const ips = await resolveAllowedIPsForHosts(CLAUDE_REQUIRED_HOSTS);

      assert(ips.length > 0, "Should resolve at least one IP");
      for (const ip of ips) {
        assert(
          /^\d+\.\d+\.\d+\.\d+$/.test(ip),
          `Each result should be an IPv4 address, got: ${ip}`,
        );
      }
    } catch (error) {
      assert(error instanceof Error);
      assertStringIncludes(
        error.message,
        "Failed to resolve provider API IPs for hosts:",
      );
    }
  });
});
