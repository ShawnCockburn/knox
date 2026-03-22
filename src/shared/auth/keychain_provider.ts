import type {
  ClaudeOAuthCredential,
  CredentialProvider,
  CredentialStore,
} from "./credential.ts";
import { CredentialError } from "./credential.ts";

const SERVICE_NAME = "Claude Code-credentials";

/** macOS Keychain-based credential provider. */
export class KeychainProvider implements CredentialProvider {
  async getCredential(): Promise<ClaudeOAuthCredential> {
    let stdout: string;
    try {
      const cmd = new Deno.Command("security", {
        args: ["find-generic-password", "-s", SERVICE_NAME, "-w"],
        stdout: "piped",
        stderr: "piped",
      });
      const output = await cmd.output();

      if (output.code !== 0) {
        const stderr = new TextDecoder().decode(output.stderr).trim();
        throw new CredentialError(
          `Keychain lookup failed (exit ${output.code}): ${stderr}`,
        );
      }
      stdout = new TextDecoder().decode(output.stdout).trim();
    } catch (e) {
      if (e instanceof CredentialError) throw e;
      throw new CredentialError("Failed to execute security command", e);
    }

    return this.parse(stdout);
  }

  private parse(raw: string): ClaudeOAuthCredential {
    let store: CredentialStore;
    try {
      store = JSON.parse(raw);
    } catch (e) {
      throw new CredentialError(
        "Failed to parse keychain credential JSON",
        e,
      );
    }

    const oauth = store?.claudeAiOauth;
    if (!oauth?.accessToken) {
      throw new CredentialError(
        "Keychain credential missing claudeAiOauth.accessToken",
      );
    }

    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      scopes: oauth.scopes ?? [],
    };
  }
}
