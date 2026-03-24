import type { KnoxEvent } from "../../shared/types.ts";
import {
  applyEvent,
  formatElapsed,
  initialDisplayState,
  markBlocked,
  markCompleted,
  markFailed,
  markRunning,
  SPINNER_FRAMES,
  STATUS_ICONS,
} from "./state.ts";
import type { DisplayStatus, ItemDisplayState } from "./state.ts";

/** ANSI escape sequences. */
const ESC = "\x1b[";
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR_LINE = `${ESC}2K`;
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const MAGENTA = `${ESC}35m`;
const BLUE = `${ESC}34m`;

/** Color palette for log panel item prefixes. */
const LOG_COLORS = [CYAN, MAGENTA, YELLOW, BLUE, GREEN];

/** Options for QueueTUI. */
export interface QueueTUIOptions {
  verbose: boolean;
  /** Queue name displayed in header. */
  queueName?: string;
  /** Override terminal dimensions (for testing). */
  columns?: number;
  rows?: number;
  /** Override output writer (for testing). */
  write?: (s: string) => void;
}

/** Color for a display status. */
function statusColor(status: DisplayStatus): string {
  switch (status) {
    case "completed":
      return GREEN;
    case "failed":
      return RED;
    case "running":
    case "aborted":
      return YELLOW;
    case "pending":
    case "blocked":
      return DIM;
  }
}

/**
 * Live-updating ANSI TUI that renders a status table to stderr.
 *
 * Public interface:
 *   constructor(items, options)
 *   update(itemId, event)   — structured lifecycle events
 *   appendLine(itemId, line) — agent output lines (verbose log panel)
 *   markItemRunning(itemId)
 *   markItemCompleted(itemId, branch?)
 *   markItemFailed(itemId, error)
 *   markItemBlocked(itemId, blockedBy)
 *   start()
 *   stop()
 */
export class QueueTUI {
  private readonly itemIds: string[];
  private readonly states: Map<string, ItemDisplayState>;
  private readonly options: QueueTUIOptions;
  private readonly startedAt: number;
  private spinnerFrame = 0;
  private intervalId: number | null = null;
  private lastLineCount = 0;
  private frozen = false;
  private aborting = false;
  private stopped = false;
  private readonly encoder = new TextEncoder();

  /** Rolling log buffer for verbose mode. */
  private readonly logBuffer: Array<{ itemId: string; line: string }> = [];
  /** Color index assigned to each item for log panel. */
  private readonly logColorMap: Map<string, string>;

  constructor(items: string[], options: QueueTUIOptions) {
    this.itemIds = items;
    this.options = options;
    this.startedAt = Date.now();
    this.states = new Map();
    this.logColorMap = new Map();

    for (let i = 0; i < items.length; i++) {
      this.states.set(items[i], initialDisplayState());
      this.logColorMap.set(items[i], LOG_COLORS[i % LOG_COLORS.length]);
    }
  }

  /** Handle a structured lifecycle event from the engine. */
  update(itemId: string, event: KnoxEvent): void {
    const current = this.states.get(itemId);
    if (!current) return;
    this.states.set(itemId, applyEvent(current, event));
  }

  /** Handle an agent output line (for verbose log panel). */
  appendLine(itemId: string, line: string): void {
    if (!this.options.verbose) return;
    this.logBuffer.push({ itemId, line });
    // Keep buffer bounded — will be trimmed to terminal height during render
    if (this.logBuffer.length > 500) {
      this.logBuffer.splice(0, this.logBuffer.length - 500);
    }
  }

  /** Mark an item as started (orchestrator beginning execution). */
  markItemRunning(itemId: string): void {
    const current = this.states.get(itemId);
    if (!current) return;
    this.states.set(itemId, markRunning(current));
  }

  /** Mark an item as completed. */
  markItemCompleted(itemId: string, branch?: string): void {
    const current = this.states.get(itemId);
    if (!current) return;
    this.states.set(itemId, markCompleted(current, branch));
  }

  /** Mark an item as failed. */
  markItemFailed(itemId: string, error: string): void {
    const current = this.states.get(itemId);
    if (!current) return;
    this.states.set(itemId, markFailed(current, error));
  }

  /** Mark an item as blocked. */
  markItemBlocked(itemId: string, blockedBy: string): void {
    const current = this.states.get(itemId);
    if (!current) return;
    this.states.set(itemId, markBlocked(current, blockedBy));
  }

  /** Start the render loop. */
  start(): void {
    this.write(HIDE_CURSOR);
    this.render();
    this.intervalId = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      if (!this.frozen) {
        this.render();
      }
    }, 80);
  }

  /** Stop rendering, show cursor, freeze display. */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.stopped = true;
    if (!this.frozen) {
      this.render(); // final render — shows [Aborted] if aborting
      this.frozen = true;
    }
    this.write(SHOW_CURSOR);
    // Print newline so summary appears below frozen frame
    this.write("\n");
  }

  /** Freeze current display (for Ctrl+C handling). */
  freeze(): void {
    if (!this.frozen) {
      this.render(); // one last render
      this.frozen = true;
    }
  }

  /** Signal that abort has been requested. Header shows [Aborting...]. */
  setAborting(): void {
    this.aborting = true;
  }

  /** Whether the run was aborted. */
  get isAborting(): boolean {
    return this.aborting;
  }

  /** Get terminal dimensions. */
  private getTermSize(): { columns: number; rows: number } {
    return {
      columns: this.options.columns ?? (Deno.consoleSize?.()?.columns ?? 80),
      rows: this.options.rows ?? (Deno.consoleSize?.()?.rows ?? 24),
    };
  }

  /** Write raw string to output (stderr or test override). */
  private write(s: string): void {
    if (this.options.write) {
      this.options.write(s);
    } else {
      Deno.stderr.writeSync(this.encoder.encode(s));
    }
  }

  /** Render the full display: header + table rows + optional log panel. */
  private render(): void {
    const { columns, rows } = this.getTermSize();
    const lines: string[] = [];

    // --- Header ---
    lines.push(this.renderHeader(columns));

    // --- Table rows ---
    const { tableLines, truncatedCount } = this.renderTable(columns, rows);
    lines.push(...tableLines);

    if (truncatedCount > 0) {
      lines.push(`  ${DIM}… and ${truncatedCount} more${RESET}`);
    }

    // --- Verbose log panel ---
    if (this.options.verbose) {
      const usedRows = lines.length;
      const logLines = this.renderLogPanel(columns, rows, usedRows);
      if (logLines.length > 0) {
        lines.push(`${DIM}${"─".repeat(Math.min(columns, 80))}${RESET}`);
        lines.push(...logLines);
      }
    }

    // Cap frame height to rows - 1 to prevent terminal scrolling
    const maxHeight = Math.max(1, rows - 1);
    if (lines.length > maxHeight) {
      lines.length = maxHeight;
    }

    // --- Overwrite in place (single buffered write) ---
    let buf = "";

    // Move cursor to start of previous frame
    if (this.lastLineCount > 0) {
      buf += `${ESC}${this.lastLineCount}A`;
    }

    // Write each line with clear-line prefix
    for (const line of lines) {
      buf += `\r${CLEAR_LINE}${line}\n`;
    }

    // Clear orphan lines if frame shrunk
    const orphans = this.lastLineCount - lines.length;
    if (orphans > 0) {
      for (let i = 0; i < orphans; i++) {
        buf += `\r${CLEAR_LINE}\n`;
      }
      // Move cursor back up to end of new frame
      buf += `${ESC}${orphans}A`;
    }

    this.write(buf);
    this.lastLineCount = lines.length;
  }

  /** Render the header line. */
  private renderHeader(columns: number): string {
    const elapsed = formatElapsed(this.startedAt);
    const counts = this.aggregateCounts();
    const name = this.options.queueName ?? "Queue";

    const parts: string[] = [];
    if (counts.running > 0) {
      parts.push(`${YELLOW}${counts.running} running${RESET}`);
    }
    if (counts.completed > 0) {
      parts.push(`${GREEN}${counts.completed} done${RESET}`);
    }
    if (counts.failed > 0) {
      parts.push(`${RED}${counts.failed} failed${RESET}`);
    }
    if (counts.pending > 0) {
      parts.push(`${DIM}${counts.pending} pending${RESET}`);
    }
    if (counts.blocked > 0) {
      parts.push(`${DIM}${counts.blocked} blocked${RESET}`);
    }
    if (counts.aborted > 0) {
      parts.push(`${YELLOW}${counts.aborted} aborted${RESET}`);
    }

    const countStr = parts.join(", ");
    let header = `${BOLD}${name}${RESET} ${DIM}${elapsed}${RESET}  ${countStr}`;

    // Abort labels
    if (this.aborting && this.stopped) {
      header += `  ${RED}${BOLD}[Aborted]${RESET}`;
    } else if (this.aborting) {
      header += `  ${YELLOW}${BOLD}[Aborting...]${RESET}`;
    }

    return header;
  }

  /** Render table rows, with truncation for large queues. */
  private renderTable(
    _columns: number,
    rows: number,
  ): { tableLines: string[]; truncatedCount: number } {
    const allItems = this.itemIds;

    // Calculate max visible rows (leave room for header, separator, log panel)
    const reservedRows = this.options.verbose ? 6 : 2; // header + margin
    const maxTableRows = Math.max(5, rows - reservedRows);

    if (allItems.length <= maxTableRows) {
      // All items fit
      return {
        tableLines: allItems.map((id) => this.renderRow(id)),
        truncatedCount: 0,
      };
    }

    // Truncation: prioritize running and failed items
    const prioritized = this.prioritizeItems(allItems, maxTableRows - 1); // -1 for "… and N more"
    return {
      tableLines: prioritized.map((id) => this.renderRow(id)),
      truncatedCount: allItems.length - prioritized.length,
    };
  }

  /** Prioritize which items to show when truncating. */
  private prioritizeItems(items: string[], maxCount: number): string[] {
    const running: string[] = [];
    const failed: string[] = [];
    const aborted: string[] = [];
    const blocked: string[] = [];
    const pending: string[] = [];
    const completed: string[] = [];

    for (const id of items) {
      const state = this.states.get(id)!;
      switch (state.status) {
        case "running":
          running.push(id);
          break;
        case "failed":
          failed.push(id);
          break;
        case "aborted":
          aborted.push(id);
          break;
        case "blocked":
          blocked.push(id);
          break;
        case "pending":
          pending.push(id);
          break;
        case "completed":
          completed.push(id);
          break;
      }
    }

    // Priority order: running, failed, aborted, pending, blocked, completed
    const ordered = [
      ...running,
      ...failed,
      ...aborted,
      ...pending,
      ...blocked,
      ...completed,
    ];
    return ordered.slice(0, maxCount);
  }

  /** Render a single table row for an item. */
  private renderRow(itemId: string): string {
    const state = this.states.get(itemId)!;
    const color = statusColor(state.status);

    // Icon (spinner for running, static for others)
    const icon = state.status === "running"
      ? SPINNER_FRAMES[this.spinnerFrame]
      : STATUS_ICONS[state.status];

    // Elapsed time
    const elapsed = state.status === "running" || state.status === "aborted"
      ? formatElapsed(state.startedAt)
      : "";

    // Phase / detail text
    let detail = state.phase;
    if (state.status === "completed" && state.branch) {
      detail = `→ ${state.branch}`;
    } else if (state.status === "failed" && state.error) {
      detail = state.error;
    } else if (state.status === "blocked" && state.blockedBy) {
      detail = `blocked by ${state.blockedBy}`;
    }

    const elapsedPart = elapsed ? ` ${DIM}${elapsed}${RESET}` : "";
    const detailPart = detail ? `  ${DIM}${detail}${RESET}` : "";

    return `  ${color}${icon}${RESET} ${itemId}${elapsedPart}${detailPart}`;
  }

  /** Render the verbose log panel. */
  private renderLogPanel(
    _columns: number,
    rows: number,
    usedRows: number,
  ): string[] {
    // +1 for the separator line
    const availableRows = Math.max(0, rows - usedRows - 1);
    if (availableRows === 0 || this.logBuffer.length === 0) return [];

    // Take the most recent lines that fit
    const visibleLines = this.logBuffer.slice(-availableRows);
    const runningCount = this.aggregateCounts().running;

    return visibleLines.map(({ itemId, line }) => {
      // With concurrency 1, skip prefix if only one running item
      if (runningCount <= 1) {
        return `  ${line}`;
      }
      const color = this.logColorMap.get(itemId) ?? DIM;
      return `  ${color}[${itemId}]${RESET} ${line}`;
    });
  }

  /** Format a one-line summary for stderr output after stop. */
  formatSummary(): string {
    const counts = this.aggregateCounts();
    const elapsed = formatElapsed(this.startedAt);

    // Determine prefix
    let prefix: string;
    if (this.aborting) {
      prefix = "Aborted";
    } else if (counts.failed > 0) {
      prefix = "Failed";
    } else {
      prefix = "Completed";
    }

    // Build count parts
    const parts: string[] = [];
    if (counts.completed > 0) parts.push(`${counts.completed} completed`);
    if (counts.failed > 0) parts.push(`${counts.failed} failed`);
    if (counts.aborted > 0) parts.push(`${counts.aborted} aborted`);
    if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`);

    return `${prefix}: ${parts.join(", ")}  (${elapsed})`;
  }

  /** Aggregate item status counts. */
  private aggregateCounts(): Record<DisplayStatus, number> {
    const counts: Record<DisplayStatus, number> = {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
      aborted: 0,
    };

    for (const state of this.states.values()) {
      counts[state.status]++;
    }

    return counts;
  }
}
