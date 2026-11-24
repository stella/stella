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

import { sql } from "drizzle-orm";

import { caseLawIndexJobs } from "@/api/db/schema";
import type { Transaction } from "@/api/db/types";
import type { SafeId } from "@/api/lib/branded-types";

/** The column's own width; a reason is a sentence, not a payload. */
const REASON_LIMIT = 2048;

type WithdrawalAuditEvent = {
  decisionId: SafeId<"caseLawDecision"> | readonly SafeId<"caseLawDecision">[];
  /** Generation the row is filed under. */
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
 *
 * The row is stamped when it is written, not when its transaction began, and
 * the caller writes it after its desired-state write. A copy is served only
 * once its apply took the state row, so any copy applied before the
 * withdrawal reached the state was reserved before this instant, and the
 * erasure evidence that compares the two
 * (`corpus-index-projection-erasure-evidence.ts`) orders the withdrawal after
 * it however long the withdrawing transaction ran.
 */
export const recordCorpusWithdrawalAuditEvent = async (
  tx: Transaction,
  { decisionId, reason }: WithdrawalAuditEvent,
): Promise<void> => {
  const decisionIds =
    typeof decisionId === "string" ? [decisionId] : decisionId;
  if (decisionIds.length === 0) {
    return;
  }
  await tx.insert(caseLawIndexJobs).values(
    decisionIds.map((id) => ({
      decisionId: id,
      operation: "withdraw" as const,
      status: "succeeded" as const,
      createdAt: sql<Date>`clock_timestamp()`,
      contentHash: null,
      detail: reason.slice(0, REASON_LIMIT),
    })),
  );
};
