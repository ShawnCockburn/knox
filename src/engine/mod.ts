// Engine
export { Knox } from "./knox.ts";
export type { KnoxEngineOptions, KnoxOutcome, KnoxResult } from "./knox.ts";

// Agent
export type {
  AgentContext,
  AgentProvider,
  ContainerHandle,
  InvokeOptions,
  InvokeResult,
} from "./agent/mod.ts";
export { ClaudeCodeAgentProvider } from "./agent/mod.ts";
export { AgentRunner } from "./agent/mod.ts";
export type { AgentRunnerOptions, AgentRunnerResult } from "./agent/mod.ts";

// Session
export { ContainerSession } from "./session/mod.ts";
export type { ContainerSessionOptions } from "./session/mod.ts";

// Prompt
export { PromptBuilder } from "./prompt/mod.ts";
export type { PromptContext } from "./prompt/mod.ts";

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
