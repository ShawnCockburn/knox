import type { KnoxEvent } from "../../shared/types.ts";
import { eventDescription, formatElapsed } from "./state.ts";

/** Format current time as HH:MM:SS. */
function timestamp(): string {
  const now = new Date();
  const h = now.getHours().toString().padStart(2, "0");
  const m = now.getMinutes().toString().padStart(2, "0");
  const s = now.getSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/**
 * Static fallback renderer for non-TTY / --no-tui mode.
 * Prints timestamped log lines to stderr — one line per event.
 */
export class StaticRenderer {
  private readonly verbose: boolean;
  private readonly startedAt: number;
  private aborting = false;

  /** Track per-item last-known status for summary. */
  private readonly itemStatuses = new Map<string, string>();

  constructor(options: { verbose: boolean }) {
    this.verbose = options.verbose;
    this.startedAt = Date.now();
  }

  /** Handle a structured lifecycle event. */
  update(itemId: string, event: KnoxEvent): void {
    const desc = eventDescription(event);
    console.error(`[${timestamp()}] [${itemId}] ${desc}`);

    // Track status for summary
    if (event.type === "container:created") {
      this.itemStatuses.set(itemId, "running");
    } else if (event.type === "aborted") {
      this.itemStatuses.set(itemId, "aborted");
    }
  }

  /** Handle an agent output line (only shown in verbose mode). */
  appendLine(itemId: string, line: string): void {
    if (this.verbose) {
      console.error(`[${timestamp()}] [${itemId}] ${line}`);
    }
  }

  /** Mark an item as started. */
  markItemRunning(itemId: string): void {
    this.itemStatuses.set(itemId, "running");
  }

  /** Mark an item as completed. */
  markItemCompleted(itemId: string, _branch?: string): void {
    this.itemStatuses.set(itemId, "completed");
  }

  /** Mark an item as failed. */
  markItemFailed(itemId: string, _error: string): void {
    this.itemStatuses.set(itemId, "failed");
  }

  /** Mark an item as blocked. */
  markItemBlocked(itemId: string, _blockedBy: string): void {
    this.itemStatuses.set(itemId, "blocked");
  }

  /** Signal that abort has been requested. */
  setAborting(): void {
    this.aborting = true;
  }

  /** Whether the run was aborted. */
  get isAborting(): boolean {
    return this.aborting;
  }

  /** No-op for static renderer. */
  start(): void {}

  /** No-op for static renderer. */
  stop(): void {}

  /** Format a one-line summary for stderr output after stop. */
  formatSummary(): string {
    const elapsed = formatElapsed(this.startedAt);

    const counts = { completed: 0, failed: 0, aborted: 0, blocked: 0 };
    for (const status of this.itemStatuses.values()) {
      if (status in counts) {
        counts[status as keyof typeof counts]++;
      }
    }

    let prefix: string;
    if (this.aborting) {
      prefix = "Aborted";
    } else if (counts.failed > 0) {
      prefix = "Failed";
    } else {
      prefix = "Completed";
    }

    const parts: string[] = [];
    if (counts.completed > 0) parts.push(`${counts.completed} completed`);
    if (counts.failed > 0) parts.push(`${counts.failed} failed`);
    if (counts.aborted > 0) parts.push(`${counts.aborted} aborted`);
    if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`);

    return `${prefix}: ${parts.join(", ")}  (${elapsed})`;
  }
}

/**
 * Format an event into a static log line (for testing).
 * Returns the line without the timestamp prefix.
 */
export function formatStaticLine(itemId: string, event: KnoxEvent): string {
  return `[${itemId}] ${eventDescription(event)}`;
}
