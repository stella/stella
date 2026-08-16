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

import { eq, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawCitationResolutionProgress } from "@/api/db/schema";
import type { CitationResolutionCursor } from "@/api/handlers/case-law/citation-resolution";
import {
  CITATION_RESOLUTION_SCOPE,
  type CitationResolutionScope,
} from "@/api/handlers/case-law/citation-resolution-status";

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
  // Written as SQL rather than through the query builder: the cursor travels
  // as opaque text because it addresses a position in a scan, and the columns
  // are branded ids. Re-branding here would claim an entity identity the walk
  // never established; the database's own `::uuid` cast is the check that
  // matters, and it rejects anything that is not one.
  const citingDecisionId = cursor?.citingDecisionId ?? null;
  const citationId = cursor?.citationId ?? null;
  await scopedDb(async (tx) => {
    // audit: skip — background walk bookkeeping, not a user action
    await tx.execute(sql`
      INSERT INTO ${caseLawCitationResolutionProgress}
        (scope, cursor_citing_decision_id, cursor_citation_id, updated_at)
      VALUES (${SCOPE}, ${citingDecisionId}::uuid, ${citationId}::uuid, now())
      ON CONFLICT (scope) DO UPDATE
        SET cursor_citing_decision_id = EXCLUDED.cursor_citing_decision_id,
            cursor_citation_id = EXCLUDED.cursor_citation_id,
            updated_at = EXCLUDED.updated_at
    `);
  });
};
