import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawHeldDecisionAttachments } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * Which of a source's publisher document ids are settled as held-decision
 * attachments: attached to the decision another source holds, or parked as
 * ambiguous or behind a takedown. Each is placed where it belongs, and
 * fetching it again would settle it the same way, so a listing walk counts
 * it as held.
 */
export const selectAttachmentDocumentIds = async (
  tx: Pick<Transaction, "select">,
  {
    sourceId,
    documentIds,
  }: {
    sourceId: SafeId<"caseLawSource">;
    documentIds: readonly string[];
  },
): Promise<Set<string>> => {
  if (documentIds.length === 0) {
    return new Set();
  }
  const rows = await tx
    .select({
      sourceDocumentId: caseLawHeldDecisionAttachments.sourceDocumentId,
    })
    .from(caseLawHeldDecisionAttachments)
    .where(
      and(
        eq(caseLawHeldDecisionAttachments.sourceId, sourceId),
        inArray(caseLawHeldDecisionAttachments.sourceDocumentId, [
          ...documentIds,
        ]),
      ),
    )
    .limit(documentIds.length);
  return new Set(rows.map(({ sourceDocumentId }) => sourceDocumentId));
};
