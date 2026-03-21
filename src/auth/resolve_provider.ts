import type { CredentialProvider } from "./credential.ts";
import { CredentialError } from "./credential.ts";
import { KeychainProvider } from "./keychain_provider.ts";
import { FileProvider } from "./file_provider.ts";

/**
 * Return the appropriate CredentialProvider for the current OS.
 * Throws CredentialError on unsupported platforms.
 */
export function resolveProvider(): CredentialProvider {
  const os = Deno.build.os;
  switch (os) {
    case "darwin":
      return new KeychainProvider();
    case "linux":
    case "windows":
      return new FileProvider();
    default:
      throw new CredentialError(`Unsupported platform: ${os}`);
  }
}
