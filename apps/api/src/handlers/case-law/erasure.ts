import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { caseLawDecisions, caseLawIndexJobs } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { removeDecisionFromCorpusIndex } from "@/api/handlers/case-law/corpus-index";
import { deleteCorpusDocument } from "@/api/handlers/case-law/corpus-storage";
import { removeDecisionFromIndex } from "@/api/handlers/case-law/search-index";
import { captureError } from "@/api/lib/analytics";
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
        indexedGeneration: true,
      },
    }),
  );

  if (!decision) {
    return false;
  }

  // 1. pg-fts projection.
  await removeDecisionFromIndex(decisionId, scopedDb);

  // 2. Object-storage corpus payloads. Delete if ANY key is present: a
  // partially ingested decision (e.g. text written but AST not yet) must
  // still have its personal data erased, not skipped.
  let corpusObjectsDeleted = true;
  if (
    decision.textS3Key !== null ||
    decision.normalizedS3Key !== null ||
    decision.astS3Key !== null
  ) {
    try {
      await deleteCorpusDocument({
        textKey: decision.textS3Key,
        sectionsKey: decision.normalizedS3Key,
        astKey: decision.astS3Key,
      });
    } catch (error) {
      corpusObjectsDeleted = false;
      captureError(error, {
        decisionId,
        step: "redactCaseLawDecision.deleteCorpusDocument",
      });
    }
  }

  // 3. Postgres canonical text + key/hash columns. Nulling content_hash
  // stops reads and both backfill loops from treating retained corpus keys
  // as active content. Keys are only retained when S3 deletion failed so a
  // later retry still knows which immutable objects to remove.
  const scrubValues = {
    fulltext: null,
    sections: null,
    documentAst: null,
    ...(corpusObjectsDeleted
      ? {
          textS3Key: null,
          normalizedS3Key: null,
          astS3Key: null,
        }
      : {}),
    contentHash: null,
    indexedHash: null,
    // indexedGeneration is intentionally NOT scrubbed here: it records
    // which corpus index holds the indexed copy, and is only cleared
    // below once the index delete-task succeeds, so a failed delete
    // keeps the retry target.
    indexedAt: null,
  };

  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
  await scopedDb((tx) => {
    // audit: skip — GDPR redaction; recorded in case_law_index_jobs below
    return tx
      .update(caseLawDecisions)
      .set(scrubValues)
      .where(eq(caseLawDecisions.id, decisionId));
  });

  // 4. corpus index (delete-task + audit row). Skipped when corpus index
  // isn't configured. This intentionally happens after local authoritative
  // stores are scrubbed, so a transient index failure cannot leave the
  // DB/S3 payloads unerased. The copy is deleted from the row's recorded
  // index (a corrected country can leave it under a different jurisdiction
  // index) and from the current-country index in case a move was
  // mid-flight; the recorded pointer is only cleared once both succeed.
  let auditedViaCorpusIndex = false;
  if (envBase.CORPUS_INDEX_ENDPOINT !== undefined) {
    const targets = new Set([
      ...(decision.indexedGeneration === null
        ? []
        : [decision.indexedGeneration]),
      corpusIndexId(generation, decision.country),
    ]);
    for (const indexId of targets) {
      await removeDecisionFromCorpusIndex(
        decisionId,
        scopedDb,
        indexId,
        "redact",
      );
    }
    // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
    await scopedDb((tx) => {
      // audit: skip — GDPR redaction bookkeeping; recorded in case_law_index_jobs above
      return tx
        .update(caseLawDecisions)
        .set({ indexedGeneration: null })
        .where(eq(caseLawDecisions.id, decisionId));
    });
    auditedViaCorpusIndex = true;
  }

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
