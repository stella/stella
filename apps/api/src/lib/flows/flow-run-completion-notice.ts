import { rootDb } from "@/api/db/root";
import { fileFlowRunCompletionNotice } from "@/api/lib/flows/flow-run-actor";
import type { FlowRunCompletionNotice } from "@/api/lib/flows/flow-run-actor";

/**
 * Tell a run's actor that the run completed, when somebody else completed it.
 *
 * A reviewer who approves a run's last review gate finishes a run whose actor
 * is usually another user. Resolving that actor (an automated run's
 * definition author) and filing a notification addressed to them are both
 * cross-user, so neither fits the reviewer's scope; this one operation does
 * both on the owner connection. The recipient is derived from the run, never
 * from the request, and the run-derived idempotency key makes it a no-op when
 * the worker's own completion already filed the same notice.
 */
export const notifyFlowRunActorOfCompletion = async (
  notice: FlowRunCompletionNotice,
): Promise<void> => {
  await fileFlowRunCompletionNotice(notice, rootDb);
};
