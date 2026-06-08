import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { caseLawDecisions, caseLawIndexJobs } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { removeDecisionFromCorpusIndex } from "@/api/handlers/case-law/corpus-index";
import { deleteCorpusDocument } from "@/api/handlers/case-law/corpus-storage";
import { removeDecisionFromIndex } from "@/api/handlers/case-law/search-index";
import type { SafeId } from "@/api/lib/branded-types";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";

/**
 * GDPR redaction / takedown for a case-law decision. Personal data lives
 * in (up to) four places once the migration is underway, and erasure
 * must hit all of them:
 *
 *   1. corpus index search index (delete-task) — if configured.
 *   2. The pg-fts projection (case_law_search_documents).
 *   3. The object-storage corpus payloads (text/sections/AST).
 *   4. The Postgres canonical columns (fulltext/sections/document_ast).
 *
 * The decision row itself is kept (citation-graph node) but stripped of
 * personal text. `content_hash` is nulled so neither backfill loop
 * re-indexes the body. The erasure is recorded in case_law_index_jobs.
 *
 * Returns false if the decision does not exist.
 */
type RedactInput = {
  decisionId: SafeId<"caseLawDecision">;
  scopedDb: ScopedDb;
  generation?: string;
};

export const redactCaseLawDecision = async ({
  decisionId,
  scopedDb,
  generation = envBase.LEGAL_SEARCH_INDEX_GENERATION,
}: RedactInput): Promise<boolean> => {
  const decision = await scopedDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: { id: { eq: decisionId } },
      columns: {
        id: true,
        country: true,
        textS3Key: true,
        normalizedS3Key: true,
        astS3Key: true,
      },
    }),
  );

  if (!decision) {
    return false;
  }

  // 1. corpus index (delete-task + audit row) in this jurisdiction's index.
  // Skipped when corpus index isn't configured.
  let auditedViaCorpusIndex = false;
  if (envBase.CORPUS_INDEX_ENDPOINT !== undefined) {
    await removeDecisionFromCorpusIndex(
      decisionId,
      scopedDb,
      corpusIndexId(generation, decision.country),
      "redact",
    );
    auditedViaCorpusIndex = true;
  }

  // 2. pg-fts projection.
  await removeDecisionFromIndex(decisionId, scopedDb);

  // 3. Object-storage corpus payloads. Delete if ANY key is present: a
  // partially ingested decision (e.g. text written but AST not yet) must
  // still have its personal data erased, not skipped.
  if (
    decision.textS3Key !== null ||
    decision.normalizedS3Key !== null ||
    decision.astS3Key !== null
  ) {
    await deleteCorpusDocument({
      textKey: decision.textS3Key,
      sectionsKey: decision.normalizedS3Key,
      astKey: decision.astS3Key,
    });
  }

  // 4. Postgres canonical text + key/hash columns. Nulling content_hash
  // stops both backfill loops from re-indexing the body.
  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
  await scopedDb((tx) => {
    // audit: skip — GDPR redaction; recorded in case_law_index_jobs below
    return tx
      .update(caseLawDecisions)
      .set({
        fulltext: null,
        sections: null,
        documentAst: null,
        textS3Key: null,
        normalizedS3Key: null,
        astS3Key: null,
        contentHash: null,
        indexedHash: null,
      })
      .where(eq(caseLawDecisions.id, decisionId));
  });

  // Ensure the erasure is auditable even when corpus index isn't configured.
  if (!auditedViaCorpusIndex) {
    // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
    await scopedDb((tx) => {
      // audit: skip — this insert IS the append-only erasure audit row
      return tx.insert(caseLawIndexJobs).values({
        decisionId,
        generation,
        operation: "redact",
        status: "succeeded",
        contentHash: null,
      });
    });
  }

  return true;
};
