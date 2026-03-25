import type { QueueManifest } from "../types.ts";
import type { QueueReport } from "../orchestrator.ts";

export interface QueueOutputResult {
  prs?: Array<{ itemId: string; url: string; number: number; draft: boolean }>;
}

export interface QueueOutput {
  deliver(
    report: QueueReport,
    manifest: QueueManifest,
  ): Promise<QueueOutputResult>;
}
