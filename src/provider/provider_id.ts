export const BUILTIN_PROVIDER_IDS = ["claude", "codex"] as const;

export type ProviderId = (typeof BUILTIN_PROVIDER_IDS)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" &&
    (BUILTIN_PROVIDER_IDS as readonly string[]).includes(value);
}
