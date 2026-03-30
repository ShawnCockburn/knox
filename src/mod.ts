// Engine
export { Knox } from "./engine/mod.ts";
export type {
  KnoxEngineOptions,
  KnoxOutcome,
  KnoxResult,
} from "./engine/mod.ts";
export type {
  AgentContext,
  AgentProvider,
  ContainerHandle,
  InvokeOptions,
  InvokeResult,
} from "./engine/mod.ts";
export { ClaudeCodeAgentProvider } from "./engine/mod.ts";
export { AgentRunner } from "./engine/mod.ts";
export type { AgentRunnerOptions, AgentRunnerResult } from "./engine/mod.ts";
export { ContainerSession } from "./engine/mod.ts";
export type { ContainerSessionOptions } from "./engine/mod.ts";
export { PromptBuilder } from "./engine/mod.ts";
export type { PromptContext } from "./engine/mod.ts";
export type {
  HostGitSourceMetadata,
  PrepareResult,
  SourceMetadata,
  SourceProvider,
} from "./engine/mod.ts";
export { GitSourceProvider, SourceStrategy } from "./engine/mod.ts";
export type {
  CollectOptions,
  HostGitSinkResult,
  ResultSink,
  SinkResult,
} from "./engine/mod.ts";
export { GitBranchSink, SinkStrategy } from "./engine/mod.ts";

// Shared
export type {
  ContainerRuntime,
  ExecOptions,
  OnLineCallback,
} from "./shared/mod.ts";
export { DockerRuntime } from "./shared/mod.ts";
export { ImageManager } from "./shared/mod.ts";
export { PreflightChecker } from "./shared/mod.ts";
export type { PreflightResult } from "./shared/mod.ts";
export {
  CredentialError,
  FileProvider,
  getCredential,
  isExpired,
  KeychainProvider,
  resolveProvider,
} from "./shared/mod.ts";
export type {
  ClaudeOAuthCredential,
  CredentialProvider,
  CredentialStore,
} from "./shared/mod.ts";
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
} from "./shared/mod.ts";
export { generateRunId, taskSlug } from "./shared/mod.ts";
export { resolveAuth } from "./shared/mod.ts";
export { resolveAllowedIPs } from "./shared/mod.ts";
export { resolveConfig } from "./shared/mod.ts";
export type { KnoxProjectConfig, ResolvedConfig } from "./shared/mod.ts";

// Queue output
export type {
  QueueOutput,
  QueueOutputResult,
} from "./queue/output/queue_output.ts";
export { BranchQueueOutput } from "./queue/output/branch_queue_output.ts";
