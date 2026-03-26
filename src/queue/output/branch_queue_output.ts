import type { QueueManifest } from "../types.ts";
import type { QueueReport } from "../orchestrator.ts";
import type { QueueOutput, QueueOutputResult } from "./queue_output.ts";

/**
 * No-op output stage. Branches already exist from the per-item ResultSink,
 * so no additional delivery is needed. This preserves current behavior as the
 * default.
 */
export class BranchQueueOutput implements QueueOutput {
  deliver(
    _report: QueueReport,
    _manifest: QueueManifest,
  ): Promise<QueueOutputResult> {
    return Promise.resolve({});
  }
}
