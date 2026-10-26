import { eq } from "drizzle-orm";

import { parseCaseLawDecisionAst } from "@stll/legal-ast/case-law-reader";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { caseLawSources, publishedCaseLawDecisions } from "@/api/db/schema";
import { corpusStorageMode } from "@/api/env-base";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import {
  persistedAstOrAbsent,
  readCorpusAst,
  readCorpusPayloadOrFallback,
} from "@/api/lib/legal-search/corpus-storage";
import type { CorpusTombstoneReader } from "@/api/lib/legal-search/corpus-tombstones";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";

const decisionAnalysisColumns = {
  id: publishedCaseLawDecisions.id,
  language: publishedCaseLawDecisions.language,
  court: publishedCaseLawDecisions.court,
  country: publishedCaseLawDecisions.country,
  decisionType: publishedCaseLawDecisions.decisionType,
  documentAst: publishedCaseLawDecisions.documentAst,
  analysis: publishedCaseLawDecisions.analysis,
  // Object-storage pointers: under canonical corpus storage the row's own
  // `documentAst` is trimmed and the object is the document.
  astS3Key: publishedCaseLawDecisions.astS3Key,
  contentHash: publishedCaseLawDecisions.contentHash,
  // The rest identifies the document to its publisher, for the
  // development-only re-parse on read (`decisions/dev-reparse.ts`).
  caseNumber: publishedCaseLawDecisions.caseNumber,
  ecli: publishedCaseLawDecisions.ecli,
  decisionDate: publishedCaseLawDecisions.decisionDate,
  documentUrl: publishedCaseLawDecisions.documentUrl,
  metadata: publishedCaseLawDecisions.metadata,
};

export const readDecisionAnalysis = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawAnalysis,
  async (
    tx: CaseLawPublicReadTransaction,
    decisionId: SafeId<"caseLawDecision">,
  ) => {
    const [row] = await tx
      .select({
        ...decisionAnalysisColumns,
        source: {
          adapterKey: caseLawSources.adapterKey,
          descriptor: caseLawSources.descriptor,
        },
      })
      .from(publishedCaseLawDecisions)
      .leftJoin(
        caseLawSources,
        eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
      )
      .where(eq(publishedCaseLawDecisions.id, decisionId))
      .limit(1);
    return row;
  },
);

type DecisionAstPointers = {
  id: SafeId<"caseLawDecision">;
  astS3Key: string | null;
  contentHash: string | null;
  documentAst: unknown;
};

/**
 * The decision's AST as the reader sees it: the corpus object where the
 * row is served from one, otherwise the row's own column. A canonical row
 * has no Postgres copy, so reading the column alone would find nothing
 * for exactly the rows object storage holds. An unreadable object with no
 * copy to fall back to throws (`CorpusPayloadUnavailableError`), the same
 * as every other reader of a trimmed row.
 *
 * The denial list comes from the caller: this function is shared by the
 * application and by the operator scripts, which run on a database login of
 * their own, so neither the reader nor this module may name a connection.
 */
export const readDecisionAnalysisAst = async (
  { astS3Key, contentHash, documentAst, id }: DecisionAstPointers,
  readTombstones: CorpusTombstoneReader,
): Promise<DocumentAst | null> => {
  if (
    corpusStorageMode === "off" ||
    astS3Key === null ||
    contentHash === null
  ) {
    return parseCaseLawDecisionAst(documentAst);
  }
  const stored = await readCorpusPayloadOrFallback({
    documentId: id,
    key: astS3Key,
    step: "analysis.readDecisionAst",
    read: async () =>
      persistedAstOrAbsent(
        await readCorpusAst(astS3Key, { readTombstones }),
        "analysis.readDecisionAst",
      ),
    fallback: async () => await Promise.resolve(documentAst),
  });
  return parseCaseLawDecisionAst(stored);
};
