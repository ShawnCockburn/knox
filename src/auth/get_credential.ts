import type { ClaudeOAuthCredential } from "./credential.ts";
import { resolveProvider } from "./resolve_provider.ts";

/**
 * Retrieve the Claude Code OAuth credential.
 *
 * Resolution order:
 * 1. CLAUDE_CODE_OAUTH_TOKEN env var (returns a minimal credential)
 * 2. Platform-specific credential store (macOS Keychain, Linux/Windows file)
 *
 * Throws CredentialError if no credential can be found.
 */
export async function getCredential(): Promise<ClaudeOAuthCredential> {
  const envToken = Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN");
  if (envToken) {
    return {
      accessToken: envToken,
      refreshToken: "",
      expiresAt: 0,
      scopes: [],
    };
  }

  const provider = resolveProvider();
  const credential = await provider.getCredential();

  if (isExpired(credential)) {
    console.error(
      `[knox] Warning: OAuth token expired at ${new Date(credential.expiresAt).toISOString()}`,
    );
  }

  return credential;
}

/** Check if a credential has expired. */
export function isExpired(credential: ClaudeOAuthCredential): boolean {
  return credential.expiresAt > 0 && Date.now() > credential.expiresAt;
}
