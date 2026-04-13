import { log } from "../log.ts";

export const CLAUDE_REQUIRED_HOSTS = [
  "api.anthropic.com",
  "statsigapi.net",
  "http-intake.logs.us5.datadoghq.com",
  "sentry.io",
];

/**
 * Resolve DNS for Anthropic API hosts with dig fallback.
 * Returns the list of allowed IPs for network restriction.
 * Throws if zero IPs can be resolved.
 */
export async function resolveAllowedIPsForHosts(
  hosts: readonly string[],
): Promise<string[]> {
  log.info(`Resolving API endpoints...`);
  const ips = new Set<string>();

  for (const host of hosts) {
    try {
      const records = await Deno.resolveDns(host, "A");
      for (const ip of records) ips.add(ip);
    } catch {
      const cmd = new Deno.Command("dig", {
        args: ["+short", host, "A"],
        stdout: "piped",
        stderr: "null",
      });
      const output = await cmd.output();
      const lines = new TextDecoder().decode(output.stdout).trim().split("\n");
      for (const line of lines) {
        if (/^\d+\.\d+\.\d+\.\d+$/.test(line)) ips.add(line);
      }
    }
  }

  if (ips.size === 0) {
    throw new Error(
      `Failed to resolve provider API IPs for hosts: ${hosts.join(", ")}`,
    );
  }

  const result = [...ips];
  log.debug(`Allowed IPs: ${result.join(", ")}`);
  return result;
}
