import type {
  ContainerHandle,
  ContainerProvider,
  InvokeResult,
  ShellContext,
} from "./agent_provider.ts";

/**
 * Orchestration counterpart to AgentRunner for shell jobs.
 * Invokes the provider exactly once — no loop, no retry, no commit nudge.
 */
export class ShellExecutor {
  private provider: ContainerProvider<ShellContext>;
  private container: ContainerHandle;
  private command: string;
  private onLine?: (line: string) => void;

  constructor(options: {
    provider: ContainerProvider<ShellContext>;
    container: ContainerHandle;
    command: string;
    onLine?: (line: string) => void;
  }) {
    this.provider = options.provider;
    this.container = options.container;
    this.command = options.command;
    this.onLine = options.onLine;
  }

  async run(): Promise<InvokeResult> {
    return await this.provider.invoke({
      container: this.container,
      command: this.command,
      onLine: this.onLine,
    });
  }
}
