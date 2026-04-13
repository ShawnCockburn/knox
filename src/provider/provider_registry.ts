import { ClaudeProviderSpec } from "./claude_provider_spec.ts";
import { CodexProviderSpec } from "./codex_provider_spec.ts";
import { isProviderId } from "./provider_id.ts";
import type { ProviderId } from "./provider_id.ts";
import type { ProviderSpec } from "./provider_spec.ts";

const PROVIDERS = new Map<ProviderId, ProviderSpec<unknown>>([
  ["claude", new ClaudeProviderSpec()],
  ["codex", new CodexProviderSpec()],
]);

export class ProviderRegistry {
  get(providerId: string): ProviderSpec<unknown> {
    if (!isProviderId(providerId)) {
      throw new Error(
        `Unsupported provider '${providerId}'. Supported providers: claude, codex.`,
      );
    }

    return PROVIDERS.get(providerId)!;
  }
}
