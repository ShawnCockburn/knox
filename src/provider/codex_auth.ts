import { join } from "@std/path";

export interface CodexAuthRecord {
  authMode?: string;
  tokens?: Record<string, unknown>;
}

export interface CodexHostAuth {
  authFilePath: string;
  authJson: string;
}

function homeDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) {
    throw new Error("Cannot determine home directory for Codex auth lookup");
  }
  return home;
}

function defaultCodexHome(): string {
  return join(homeDir(), ".codex");
}

function candidateAuthPaths(): string[] {
  const paths: string[] = [];
  const codexHome = Deno.env.get("CODEX_HOME");
  if (codexHome) {
    paths.push(join(codexHome, "auth.json"));
  }

  const defaultPath = join(defaultCodexHome(), "auth.json");
  if (!paths.includes(defaultPath)) {
    paths.push(defaultPath);
  }

  return paths;
}

function isValidAuthStore(value: unknown): value is CodexAuthRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!record.tokens || typeof record.tokens !== "object") return false;
  const tokens = record.tokens as Record<string, unknown>;
  return typeof tokens.access_token === "string" ||
    typeof tokens.refresh_token === "string";
}

export async function resolveCodexHostAuth(): Promise<CodexHostAuth> {
  const candidates = candidateAuthPaths();
  const found: CodexHostAuth[] = [];

  for (const authFilePath of candidates) {
    try {
      const authJson = await Deno.readTextFile(authFilePath);
      const parsed = JSON.parse(authJson);
      if (!isValidAuthStore(parsed)) {
        throw new Error(
          `Codex auth file at ${authFilePath} does not contain a supported auth store`,
        );
      }
      found.push({ authFilePath, authJson });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        continue;
      }
      if (error instanceof SyntaxError) {
        throw new Error(
          `Failed to parse Codex auth file at ${authFilePath}: ${error.message}`,
        );
      }
      throw error;
    }
  }

  if (found.length === 0) {
    throw new Error(
      "Codex auth not found. Run `codex login` on the host first so Knox can reuse the cached login state.",
    );
  }

  if (found.length > 1) {
    const distinctPayloads = new Set(found.map((entry) => entry.authJson));
    if (distinctPayloads.size > 1) {
      throw new Error(
        "Multiple Codex auth sources were found and they disagree. Set CODEX_HOME explicitly or remove the stale auth file before running Knox.",
      );
    }
  }

  return found[0];
}
