import { resolveAllowedIPsForHosts } from "../shared/knox/resolve_network.ts";
import { DefaultResolvedExecutionContext } from "./resolved_execution_context.ts";
import { ProviderRegistry } from "./provider_registry.ts";
import type { ResolvedExecutionContext } from "./resolved_execution_context.ts";

export interface ResolveExecutionContextOptions {
  provider: string;
  registry?: ProviderRegistry;
}

export async function resolveExecutionContext(
  options: ResolveExecutionContextOptions,
): Promise<ResolvedExecutionContext> {
  const registry = options.registry ?? new ProviderRegistry();
  const spec = registry.get(options.provider);
  const auth = await spec.resolveHostAuth();
  const allowedIPs = await resolveAllowedIPsForHosts(spec.requiredHosts(auth));
  return new DefaultResolvedExecutionContext(spec, auth, allowedIPs);
}
