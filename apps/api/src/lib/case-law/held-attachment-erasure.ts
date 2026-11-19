import { and, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisionAliases,
  caseLawHeldDecisionAttachments,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { replayWrite } from "@/api/lib/case-law/replay-write";

/**
 * Park every record another source held as an attachment to a decision the
 * erasure fence is taking down: a takedown covers every publisher's copy of
 * the decision, so the record is never written as a decision of its own,
 * and its metadata and raw pointer are dropped. Its raw payload sits under
 * the decision's own raw prefix, which the erasure's sweep deletes.
 *
 * Runs in the fence's transaction, which holds the decision's row; the
 * attach step locks the same row before it writes.
 */
export const parkAttachmentsOfErasedDecisionTx = async (
  tx: Transaction,
  decisionId: SafeId<"caseLawDecision">,
): Promise<void> => {
  // Its own id and every id retired into it, which an attachment made
  // before the merge still names.
  const retired = await tx
    .select({ id: caseLawDecisionAliases.retiredDecisionId })
    .from(caseLawDecisionAliases)
    .where(eq(caseLawDecisionAliases.canonicalDecisionId, decisionId));
  const park = replayWrite(
    caseLawHeldDecisionAttachments,
    {
      hostWithdrawnAt: sql`coalesce(${caseLawHeldDecisionAttachments.hostWithdrawnAt}, now())`,
      metadata: null,
      sourceRawS3Key: null,
      sourceRawContentType: null,
    },
    {
      modifiedAt: {
        column: caseLawHeldDecisionAttachments.updatedAt,
        value: new Date(),
      },
    },
  );
  // audit: skip — GDPR redaction; the fence records it in case_law_index_jobs
  await tx
    .update(caseLawHeldDecisionAttachments)
    .set(park.set)
    .where(
      and(
        inArray(caseLawHeldDecisionAttachments.hostDecisionId, [
          decisionId,
          ...retired.map(({ id }) => id),
        ]),
        park.setWhere,
      ),
    );
};
