import type { KnoxEvent } from "../../shared/types.ts";

/** Display status for a queue item. */
export type DisplayStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "aborted";

/** Display state for a single queue item, derived from events. */
export interface ItemDisplayState {
  status: DisplayStatus;
  /** Current phase text (e.g., "setting up", "loop 2/5"). */
  phase: string;
  /** Current loop number. */
  loop: number;
  /** Max loops configured. */
  maxLoops: number;
  /** Timestamp when item started running. */
  startedAt: number | null;
  /** Result branch name (set on completion). */
  branch: string | null;
  /** Brief error reason (set on failure). */
  error: string | null;
  /** ID of blocking item (set when blocked). */
  blockedBy: string | null;
}

/** Create the initial display state for a pending item. */
export function initialDisplayState(): ItemDisplayState {
  return {
    status: "pending",
    phase: "",
    loop: 0,
    maxLoops: 0,
    startedAt: null,
    branch: null,
    error: null,
    blockedBy: null,
  };
}

/**
 * Pure reducer: apply a KnoxEvent to an ItemDisplayState, returning a new state.
 * This is the core state machine extracted for testability.
 */
export function applyEvent(
  state: ItemDisplayState,
  event: KnoxEvent,
): ItemDisplayState {
  switch (event.type) {
    case "container:created":
      return {
        ...state,
        status: "running",
        phase: "setting up",
        startedAt: state.startedAt ?? Date.now(),
      };
    case "loop:start":
      return {
        ...state,
        status: "running",
        phase: `loop ${event.loop}/${event.maxLoops}`,
        loop: event.loop,
        maxLoops: event.maxLoops,
      };
    case "loop:end":
      return {
        ...state,
        phase: event.completed
          ? "agent complete"
          : `loop ${state.loop}/${state.maxLoops} done`,
      };
    case "check:failed":
      return {
        ...state,
        phase: "check failed, retrying",
      };
    case "nudge:result":
      return {
        ...state,
        phase: "committing",
      };
    case "bundle:extracted":
      return {
        ...state,
        phase: "extracting results",
      };
    case "aborted":
      return {
        ...state,
        status: "aborted",
        phase: "aborted",
      };
    default:
      return state;
  }
}

/**
 * Mark an item as started (transition from pending to running).
 * Called when the orchestrator begins running an item, before any engine events.
 */
export function markRunning(state: ItemDisplayState): ItemDisplayState {
  return {
    ...state,
    status: "running",
    phase: "starting",
    startedAt: Date.now(),
  };
}

/** Mark an item as completed with an optional branch name. */
export function markCompleted(
  state: ItemDisplayState,
  branch?: string,
): ItemDisplayState {
  return {
    ...state,
    status: "completed",
    phase: "done",
    branch: branch ?? null,
  };
}

/** Mark an item as failed with an error message. */
export function markFailed(
  state: ItemDisplayState,
  error: string,
): ItemDisplayState {
  return {
    ...state,
    status: "failed",
    phase: "failed",
    error,
  };
}

/** Mark an item as blocked by another item. */
export function markBlocked(
  state: ItemDisplayState,
  blockedBy: string,
): ItemDisplayState {
  return {
    ...state,
    status: "blocked",
    phase: "blocked",
    blockedBy,
  };
}

/** Status icons for each display status. */
export const STATUS_ICONS: Record<DisplayStatus, string> = {
  pending: "·",
  running: "⠋", // placeholder — spinner cycles through braille frames
  completed: "✓",
  failed: "✗",
  aborted: "⚠",
  blocked: "○",
};

/** Braille spinner frames for running items. */
export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

/** Format elapsed time from a start timestamp. */
export function formatElapsed(startedAt: number | null): string {
  if (startedAt === null) return "";
  const elapsed = Math.max(0, Date.now() - startedAt);
  const totalSeconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

/** Map a KnoxEvent type to a human-readable description for static logging. */
export function eventDescription(event: KnoxEvent): string {
  switch (event.type) {
    case "container:created":
      return "container created";
    case "loop:start":
      return `loop ${event.loop}/${event.maxLoops} started`;
    case "loop:end":
      return event.completed
        ? "agent completed"
        : `loop ${event.loop} finished`;
    case "check:failed":
      return `check failed (loop ${event.loop})`;
    case "nudge:result":
      return event.committed ? "committed changes" : "nudge sent (no commit)";
    case "bundle:extracted":
      return "bundle extracted";
    case "aborted":
      return "aborted";
    default:
      return "unknown event";
  }
}
