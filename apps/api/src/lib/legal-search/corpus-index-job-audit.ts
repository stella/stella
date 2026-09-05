/**
 * Audit writer for corpus-level mutations of a case-law decision.
 *
 * A decision is a global corpus row: it belongs to no workspace and no
 * organization, and `audit_logs` is keyed by both, so it cannot hold this
 * history. `case_law_index_jobs` is the append-only trail of what entered,
 * left or was taken back from the corpus, and this is its writer.
 *
 * Beside the recorders in `audit-log.ts` rather than inside the handler,
 * for the same reason they are: the write belongs to the trail, not to
 * whichever caller happens to make it.
 */

import type { Transaction } from "@/api/db/root";
import { caseLawIndexJobs } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

/** The column's own width; a reason is a sentence, not a payload. */
const REASON_LIMIT = 2048;

type WithdrawalAuditEvent = {
  decisionId: SafeId<"caseLawDecision">;
  /** Generation the row is filed under. */
  generation: string;
  /** Why the document was taken back, in the caller's own words. */
  reason: string;
};

/**
 * Record that a decision's document was withdrawn.
 *
 * `withdraw` rather than `redact`: a redact row is read as a takedown
 * tombstone, and a withdrawal is the opposite claim — the row keeps its
 * identity and its stored payload, and a later parser may replay it into
 * a document again.
 */
export const recordCorpusWithdrawalAuditEvent = async (
  tx: Transaction,
  { decisionId, generation, reason }: WithdrawalAuditEvent,
): Promise<void> => {
  await tx.insert(caseLawIndexJobs).values({
    decisionId,
    generation,
    operation: "withdraw",
    status: "succeeded",
    contentHash: null,
    // `detail`, not `error_message`: the row succeeded, and a reason filed
    // in the failure column reads as a failure that never happened.
    detail: reason.slice(0, REASON_LIMIT),
  });
};
