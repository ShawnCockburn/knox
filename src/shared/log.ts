export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ANSI color codes
const RESET = "\x1b[0m";
const GRAY = "\x1b[90m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

function colorEnabled(): boolean {
  return Deno.stderr.isTerminal() && !Deno.env.get("NO_COLOR");
}

function colorize(text: string, color: string): string {
  if (!colorEnabled()) return text;
  return `${color}${text}${RESET}`;
}

/** Callback that receives every log message regardless of level or mute state. */
export type LogListener = (level: LogLevel, message: string) => void;

class Logger {
  private threshold: number = LEVELS.info;
  private muted = false;
  private listener: LogListener | null = null;

  setLevel(level: LogLevel): void {
    this.threshold = LEVELS[level];
  }

  /** Suppress all log output (for TUI mode). */
  mute(): void {
    this.muted = true;
  }

  /** Restore log output. */
  unmute(): void {
    this.muted = false;
  }

  /** Set a listener that receives all log messages (bypasses level/mute). */
  setListener(listener: LogListener | null): void {
    this.listener = listener;
  }

  debug(message: string): void {
    this.listener?.("debug", message);
    if (!this.muted && LEVELS.debug >= this.threshold) {
      console.error(`${colorize("[knox:DEBUG]", GRAY)} ${message}`);
    }
  }

  info(message: string): void {
    this.listener?.("info", message);
    if (!this.muted && LEVELS.info >= this.threshold) {
      console.error(`[knox:INFO] ${message}`);
    }
  }

  warn(message: string): void {
    this.listener?.("warn", message);
    if (!this.muted && LEVELS.warn >= this.threshold) {
      console.error(`${colorize("[knox:WARN]", YELLOW)} ${message}`);
    }
  }

  error(message: string): void {
    this.listener?.("error", message);
    if (!this.muted && LEVELS.error >= this.threshold) {
      console.error(`${colorize("[knox:ERROR]", RED)} ${message}`);
    }
  }

  always(message: string): void {
    this.listener?.("info", message);
    console.error(`[knox] ${message}`);
  }
}

export const log = new Logger();
