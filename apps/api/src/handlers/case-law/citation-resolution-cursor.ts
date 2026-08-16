/**
 * Where the standing resolution walk had got to.
 *
 * Read once when a task starts, written after every batch. Losing it costs a
 * slower start and nothing else: the walk's predicate is `resolution_status =
 * 'pending'`, and settled rows leave it, so starting from the beginning
 * re-examines nothing. What the position saves is the traversal of index
 * entries autovacuum has not reclaimed yet, which on a burn-down of this size
 * accumulates at the left edge faster than a restart can afford to re-read
 * them.
 */

import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawCitationResolutionProgress } from "@/api/db/schema";
import type { CitationResolutionCursor } from "@/api/handlers/case-law/citation-resolution";
import {
  CITATION_RESOLUTION_SCOPE,
  type CitationResolutionScope,
} from "@/api/handlers/case-law/citation-resolution-status";
import { toSafeId } from "@/api/lib/branded-types";

const SCOPE: CitationResolutionScope = CITATION_RESOLUTION_SCOPE.GLOBAL;

export const loadCitationResolutionCursor = async (
  scopedDb: ScopedDb,
): Promise<CitationResolutionCursor | null> =>
  await scopedDb(async (tx) => {
    const rows = await tx
      .select({
        citingDecisionId:
          caseLawCitationResolutionProgress.cursorCitingDecisionId,
        citationId: caseLawCitationResolutionProgress.cursorCitationId,
      })
      .from(caseLawCitationResolutionProgress)
      .where(eq(caseLawCitationResolutionProgress.scope, SCOPE))
      .limit(1);
    const row = rows.at(0);
    // The pair is enforced whole by a check constraint, so one column
    // answering is enough to read the other; both are read anyway because a
    // half-cursor would silently restart the walk mid-corpus.
    if (!row?.citingDecisionId || !row.citationId) {
      return null;
    }
    return {
      citingDecisionId: row.citingDecisionId,
      citationId: row.citationId,
    };
  });

/**
 * Record the position, including the wrap back to the beginning. The wrap is
 * written rather than left implicit: a task that stops right after draining
 * must not resume at the far end of a queue that has since been refilled
 * behind it.
 */
export const saveCitationResolutionCursor = async (
  scopedDb: ScopedDb,
  cursor: CitationResolutionCursor | null,
): Promise<void> => {
  // The cursor travels as opaque text because it addresses a position in a
  // scan; the columns hold entity ids, and these are the ids the scan reported
  // having reached, so they are parsed back rather than asserted.
  const columns = {
    cursorCitingDecisionId: cursor
      ? toSafeId<"caseLawDecision">(cursor.citingDecisionId)
      : null,
    cursorCitationId: cursor
      ? toSafeId<"caseLawCitation">(cursor.citationId)
      : null,
    updatedAt: new Date(),
  };
  await scopedDb(async (tx) => {
    // audit: skip — background walk bookkeeping, not a user action
    await tx
      .insert(caseLawCitationResolutionProgress)
      .values({ scope: SCOPE, ...columns })
      .onConflictDoUpdate({
        target: caseLawCitationResolutionProgress.scope,
        set: columns,
      });
  });
};
