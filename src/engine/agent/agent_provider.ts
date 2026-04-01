import type {
  ExecOptions,
  OnLineCallback,
} from "../../shared/runtime/container_runtime.ts";
import type { ExecResult } from "../../shared/types.ts";

/**
 * Narrow container surface passed to providers via context.
 * Providers use this to execute commands, stream output, and copy files
 * into the container — without access to the full ContainerSession.
 */
export interface ContainerHandle {
  exec(command: string[], options?: ExecOptions): Promise<ExecResult>;
  execStream(
    command: string[],
    options: ExecOptions & { onLine: OnLineCallback },
  ): Promise<number>;
  copyIn(hostPath: string, containerPath: string): Promise<void>;
}

/** Base context shared by all container providers. */
export interface ContainerContext {
  container: ContainerHandle;
  onLine?: (line: string) => void;
}

/** Context for shell (single-command) invocations. */
export interface ShellContext extends ContainerContext {
  command: string;
}

/** Context for LLM agent loop invocations. */
export interface LlmAgentContext extends ContainerContext {
  task: string;
  loopNumber: number;
  maxLoops: number;
  checkFailure?: string;
  customPrompt?: string;
  signal?: AbortSignal;
}

/** Per-invocation options. Extensibility point for future config. */
export type InvokeOptions = Record<string, never>;

/** Result of a single provider invocation. */
export interface InvokeResult {
  completed: boolean;
  exitCode: number;
}

/**
 * Generic root provider interface. Each implementation owns invocation
 * and completion detection for a specific container workload.
 */
export interface ContainerProvider<TContext extends ContainerContext> {
  invoke(ctx: TContext, options?: InvokeOptions): Promise<InvokeResult>;
}

/**
 * LLM agent provider — marker interface narrowing the generic bound
 * to LlmAgentContext. No additional methods.
 */
export interface AgentProvider<T extends LlmAgentContext = LlmAgentContext>
  extends ContainerProvider<T> {}
