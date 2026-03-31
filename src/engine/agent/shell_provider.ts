import type {
  ContainerProvider,
  InvokeResult,
  ShellContext,
} from "./agent_provider.ts";

/**
 * Runs a single shell command inside a container.
 * Streams output through the onLine callback and maps exit code to InvokeResult.
 */
export class ShellProvider implements ContainerProvider<ShellContext> {
  async invoke(ctx: ShellContext): Promise<InvokeResult> {
    const exitCode = await ctx.container.execStream(
      ["sh", "-c", ctx.command],
      {
        onLine: (line, _stream) => {
          ctx.onLine?.(line);
        },
      },
    );

    return { completed: exitCode === 0, exitCode };
  }
}
