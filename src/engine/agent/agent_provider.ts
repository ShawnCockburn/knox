import type {
  ExecOptions,
  OnLineCallback,
} from "../../shared/runtime/container_runtime.ts";
import type { ExecResult } from "../../shared/types.ts";

/**
 * Narrow container surface passed to providers via AgentContext.
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

/** Per-invocation context passed from the engine to the provider. */
export interface AgentContext {
  container: ContainerHandle;
  task: string;
  loopNumber: number;
  maxLoops: number;
  checkFailure?: string;
  customPrompt?: string;
  onLine?: (line: string) => void;
}

/** Per-invocation options. Extensibility point for future config. */
export type InvokeOptions = Record<string, never>;

/** Result of a single provider invocation. */
export interface InvokeResult {
  completed: boolean;
  exitCode: number;
}

/**
 * Agent provider interface. Each implementation owns invocation,
 * prompt building, and completion detection for a specific agent binary.
 */
export interface AgentProvider {
  invoke(ctx: AgentContext, options?: InvokeOptions): Promise<InvokeResult>;
}
