import type { KnoxResult } from "../engine/knox.ts";
import { SinkStrategy } from "../engine/sink/result_sink.ts";

/** Format duration in milliseconds to a human-readable string. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/** Format a KnoxResult into a structured CLI summary. */
export function formatSummary(result: KnoxResult): string {
  const status = result.completed
    ? `completed (${result.loopsRun}/${result.maxLoops} loops)`
    : `stopped (${result.loopsRun}/${result.maxLoops} loops)`;

  const checkStr = result.checkPassed === null
    ? "n/a"
    : result.checkPassed
    ? "passed"
    : "failed";

  const lines = [
    ``,
    `[knox] Summary`,
    `  Status:      ${status}`,
    `  Duration:    ${formatDuration(result.durationMs)}`,
    `  Model:       ${result.model}`,
  ];

  // Strategy-specific fields
  if (result.sink.strategy === SinkStrategy.HostGit) {
    lines.push(`  Branch:      ${result.sink.branchName}`);
    lines.push(`  Commits:     ${result.sink.commitCount}`);
  }

  lines.push(`  Auto-commit: ${result.autoCommitted ? "yes" : "no"}`);
  lines.push(`  Check:       ${checkStr}`);
  lines.push(`  Strategy:    ${result.sink.strategy}`);

  // Next-step hints (strategy-specific)
  if (result.sink.strategy === SinkStrategy.HostGit) {
    const branch = result.sink.branchName;
    lines.push(``);
    lines.push(`  To review:   git log main..${branch}`);
    lines.push(`  To merge:    git merge ${branch}`);
  }

  return lines.join("\n");
}
