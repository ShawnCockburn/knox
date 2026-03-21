import { join } from "@std/path";
import type {
  ClaudeOAuthCredential,
  CredentialProvider,
  CredentialStore,
} from "./credential.ts";
import { CredentialError } from "./credential.ts";

/** File-based credential provider for Linux and Windows. */
export class FileProvider implements CredentialProvider {
  async getCredential(): Promise<ClaudeOAuthCredential> {
    const configDir = Deno.env.get("CLAUDE_CONFIG_DIR") ??
      join(this.homeDir(), ".claude");
    const credPath = join(configDir, ".credentials.json");

    let raw: string;
    try {
      raw = await Deno.readTextFile(credPath);
    } catch (e) {
      throw new CredentialError(
        `Could not read credential file at ${credPath}`,
        e,
      );
    }

    let store: CredentialStore;
    try {
      store = JSON.parse(raw);
    } catch (e) {
      throw new CredentialError("Failed to parse credential file JSON", e);
    }

    const oauth = store?.claudeAiOauth;
    if (!oauth?.accessToken) {
      throw new CredentialError(
        "Credential file missing claudeAiOauth.accessToken",
      );
    }

    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      scopes: oauth.scopes ?? [],
    };
  }

  private homeDir(): string {
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
    if (!home) {
      throw new CredentialError("Cannot determine home directory");
    }
    return home;
  }
}
