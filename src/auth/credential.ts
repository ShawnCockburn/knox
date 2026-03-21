/** OAuth credential as stored by Claude Code. */
export interface ClaudeOAuthCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

/** Envelope matching the JSON structure stored by Claude Code. */
export interface CredentialStore {
  claudeAiOauth: ClaudeOAuthCredential;
}

/** Error thrown when credentials cannot be retrieved. */
export class CredentialError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = "CredentialError";
  }
}

/**
 * Strategy interface for retrieving Claude Code OAuth credentials.
 * Implementations exist per platform.
 */
export interface CredentialProvider {
  getCredential(): Promise<ClaudeOAuthCredential>;
}
