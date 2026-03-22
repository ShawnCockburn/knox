/** Strategy tag for source providers. */
export enum SourceStrategy {
  HostGit = "host-git",
}

/** Metadata from a host-git source. */
export interface HostGitSourceMetadata {
  readonly strategy: SourceStrategy.HostGit;
  /** Host HEAD SHA at snapshot time. */
  readonly baseCommit: string;
  /** Absolute path to the host repo. */
  readonly repoPath: string;
}

/** Discriminated union of all source metadata variants. */
export type SourceMetadata = HostGitSourceMetadata;

/** Result of preparing a source. */
export interface PrepareResult {
  /** Path to the prepared source on the host filesystem. */
  readonly hostPath: string;
  /** Strategy-specific metadata. */
  readonly metadata: SourceMetadata;
  /** Non-fatal warnings (e.g., dirty working tree). */
  readonly warnings?: string[];
}

/**
 * Container-agnostic interface for preparing source material.
 * Knox copies the prepared hostPath into the container.
 */
export interface SourceProvider {
  prepare(runId: string): Promise<PrepareResult>;
  cleanup(runId: string): Promise<void>;
}
