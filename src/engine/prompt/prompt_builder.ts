import { DEFAULT_PROMPT } from "./default_prompt.ts";

/** Context for constructing a per-loop prompt. */
export interface PromptContext {
  task: string;
  loopNumber: number;
  maxLoops: number;
  progressFileContent?: string;
  gitLog?: string;
  checkFailure?: string;
  customPrompt?: string;
}

export class PromptBuilder {
  /** Build the full prompt for a single loop iteration. */
  build(ctx: PromptContext): string {
    const sections: string[] = [];

    // Base prompt
    sections.push(ctx.customPrompt ?? DEFAULT_PROMPT);

    // Task
    sections.push(`=== TASK ===\n${ctx.task}`);

    // Loop info
    sections.push(`=== LOOP ===\nLoop ${ctx.loopNumber} of ${ctx.maxLoops}`);

    // Progress file
    if (ctx.progressFileContent) {
      sections.push(
        `=== PROGRESS (knox-progress.txt) ===\n${ctx.progressFileContent}`,
      );
    }

    // Git log from previous loops
    if (ctx.gitLog) {
      sections.push(
        `=== GIT LOG (previous loops) ===\n${ctx.gitLog}`,
      );
    }

    // Check failure from previous loop
    if (ctx.checkFailure) {
      sections.push(
        `=== CHECK FAILURE (previous loop) ===\nThe previous loop signaled completion, but the verification check failed. Please fix the issue and try again.\n\n${ctx.checkFailure}`,
      );
    }

    return sections.join("\n\n");
  }
}
