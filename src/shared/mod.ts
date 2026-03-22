// Runtime
export type {
  ContainerRuntime,
  ExecOptions,
  OnLineCallback,
} from "./runtime/mod.ts";
export { DockerRuntime } from "./runtime/mod.ts";

// Image
export { ImageManager } from "./image/mod.ts";

// Preflight
export { PreflightChecker } from "./preflight/mod.ts";
export type { PreflightResult } from "./preflight/mod.ts";

// Auth
export {
  CredentialError,
  FileProvider,
  getCredential,
  isExpired,
  KeychainProvider,
  resolveProvider,
} from "./auth/mod.ts";
export type {
  ClaudeOAuthCredential,
  CredentialProvider,
  CredentialStore,
} from "./auth/mod.ts";

// Types
export type {
  BuildImageOptions,
  CommitOptions,
  ContainerId,
  CreateContainerOptions,
  ExecResult,
  FailurePhase,
  ImageId,
  KnoxEvent,
  RunId,
} from "./types.ts";
export { generateRunId, taskSlug } from "./types.ts";

// Pre-container functions
export { resolveAuth } from "./knox/mod.ts";
export { resolveAllowedIPs } from "./knox/mod.ts";

// Logger
export { log } from "./log.ts";
export type { LogLevel } from "./log.ts";
