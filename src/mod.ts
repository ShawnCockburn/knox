export { Knox } from "./knox.ts";
export type { KnoxOptions, KnoxResult } from "./knox.ts";
export type {
  ContainerRuntime,
  ExecOptions,
  OnLineCallback,
} from "./runtime/mod.ts";
export { DockerRuntime } from "./runtime/mod.ts";
export { ImageManager } from "./image/mod.ts";
export { AgentRunner } from "./agent/mod.ts";
export type { AgentRunnerOptions, AgentRunnerResult } from "./agent/mod.ts";
export { ContainerSession } from "./session/mod.ts";
export type { ContainerSessionOptions } from "./session/mod.ts";
export { PromptBuilder } from "./prompt/mod.ts";
export type { PromptContext } from "./prompt/mod.ts";
export { PreflightChecker } from "./preflight/mod.ts";
export type { PreflightResult } from "./preflight/mod.ts";
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
export type {
  BuildImageOptions,
  CommitOptions,
  ContainerId,
  CreateContainerOptions,
  ExecResult,
  ImageId,
  RunId,
} from "./types.ts";
export { generateRunId, taskSlug } from "./types.ts";

// Pre-container functions
export { resolveAuth } from "./knox/mod.ts";
export { resolveAllowedIPs } from "./knox/mod.ts";

// Source provider
export type {
  HostGitSourceMetadata,
  PrepareResult,
  SourceMetadata,
  SourceProvider,
} from "./source/mod.ts";
export { GitSourceProvider, SourceStrategy } from "./source/mod.ts";

// Result sink
export type {
  CollectOptions,
  HostGitSinkResult,
  ResultSink,
  SinkResult,
} from "./sink/mod.ts";
export { GitBranchSink, SinkStrategy } from "./sink/mod.ts";
