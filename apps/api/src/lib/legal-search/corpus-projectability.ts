/**
 * Whether a canonical row is projectable: its text has settled, so a desired
 * state can be derived from it.
 *
 * The ingestion writers insert a new decision or document before its text is
 * durable, and give it desired states only in the transaction that settles
 * that text, for every active generation at once:
 *
 * - case law: the settle transaction moves `corpus_mirror_status` to
 *   `settled` (`settleCaseLawCorpusMirrorTx`) and projects the decision; a
 *   row written without a mirror is `settled` from its insert and projected
 *   in the row's own transaction;
 * - legislation: the settle transaction writes the body's `content_hash`
 *   (`settleLegislationCorpusProjection`) and projects the document.
 *
 * A row that is not projectable and has no desired state in any generation is
 * shown by no generation, so neither the seeding walk nor a flip owes it
 * anything; its settle transaction seeds every active generation. Every other
 * row must have a desired state in every active generation that routes it.
 * The seeding walk (`corpus-index-projection-bootstrap.ts`) and the
 * test-database seeding guard read this one definition.
 */
import { sql } from "drizzle-orm";

import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
  legislationDocuments,
} from "@/api/db/schema";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";

export const CORPUS_ROW_PROJECTABLE = {
  case_law: sql<boolean>`${caseLawDecisions.corpusMirrorStatus} = ${sql.raw(`'${CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED}'`)}`,
  legislation: sql<boolean>`${legislationDocuments.contentHash} IS NOT NULL`,
} as const satisfies Record<CorpusFamily, unknown>;
