import { CredentialError, getCredential } from "../auth/mod.ts";
import { log } from "../log.ts";

/**
 * Resolve authentication by trying OAuth first, then falling back to API key.
 * Returns the augmented env var array with the appropriate credential.
 */
export async function resolveAuth(baseEnv: string[]): Promise<string[]> {
  log.info(`Resolving authentication...`);
  const envVars = [...baseEnv];
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");

  try {
    const credential = await getCredential();
    envVars.push(`CLAUDE_CODE_OAUTH_TOKEN=${credential.accessToken}`);
    log.debug(`Using OAuth credential for authentication`);
  } catch (e) {
    if (e instanceof CredentialError) {
      if (apiKey) {
        envVars.push(`ANTHROPIC_API_KEY=${apiKey}`);
        log.debug(`Using ANTHROPIC_API_KEY for authentication`);
      }
    } else {
      throw e;
    }
  }

  return envVars;
}
