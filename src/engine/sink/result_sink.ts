import type { SourceMetadata } from "../source/source_provider.ts";

/** Strategy tag for result sinks. */
export enum SinkStrategy {
  HostGit = "host-git",
}

/** Result from the host-git sink. */
export interface HostGitSinkResult {
  readonly strategy: SinkStrategy.HostGit;
  readonly branchName: string;
  readonly commitCount: number;
  readonly autoCommitted: boolean;
}

/** Discriminated union of all sink result variants. */
export type SinkResult = HostGitSinkResult;

/** Options passed to ResultSink.collect(). */
export interface CollectOptions {
  readonly runId: string;
  readonly bundlePath: string;
  readonly metadata: SourceMetadata;
  readonly taskSlug: string;
  readonly autoCommitted: boolean;
  /** Override the computed branch name (used by queue orchestrator for groups). */
  readonly branchName?: string;
}

/**
 * Container-agnostic interface for consuming agent results.
 * Knox extracts the bundle from the container and passes the host path here.
 */
export interface ResultSink {
  collect(options: CollectOptions): Promise<SinkResult>;
  cleanup(runId: string): Promise<void>;
}
