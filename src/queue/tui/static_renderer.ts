import type { KnoxEvent } from "../../shared/types.ts";
import { eventDescription } from "./state.ts";

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

  constructor(options: { verbose: boolean }) {
    this.verbose = options.verbose;
  }

  /** Handle a structured lifecycle event. */
  update(itemId: string, event: KnoxEvent): void {
    const desc = eventDescription(event);
    console.error(`[${timestamp()}] [${itemId}] ${desc}`);
  }

  /** Handle an agent output line (only shown in verbose mode). */
  appendLine(itemId: string, line: string): void {
    if (this.verbose) {
      console.error(`[${timestamp()}] [${itemId}] ${line}`);
    }
  }

  /** No-op for static renderer. */
  start(): void {}

  /** No-op for static renderer. */
  stop(): void {}
}

/**
 * Format an event into a static log line (for testing).
 * Returns the line without the timestamp prefix.
 */
export function formatStaticLine(itemId: string, event: KnoxEvent): string {
  return `[${itemId}] ${eventDescription(event)}`;
}
