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

class Logger {
  private threshold: number = LEVELS.info;

  setLevel(level: LogLevel): void {
    this.threshold = LEVELS[level];
  }

  debug(message: string): void {
    if (LEVELS.debug >= this.threshold) {
      console.error(`${colorize("[knox:DEBUG]", GRAY)} ${message}`);
    }
  }

  info(message: string): void {
    if (LEVELS.info >= this.threshold) {
      console.error(`[knox:INFO] ${message}`);
    }
  }

  warn(message: string): void {
    if (LEVELS.warn >= this.threshold) {
      console.error(`${colorize("[knox:WARN]", YELLOW)} ${message}`);
    }
  }

  error(message: string): void {
    if (LEVELS.error >= this.threshold) {
      console.error(`${colorize("[knox:ERROR]", RED)} ${message}`);
    }
  }

  always(message: string): void {
    console.error(`[knox] ${message}`);
  }
}

export const log = new Logger();
