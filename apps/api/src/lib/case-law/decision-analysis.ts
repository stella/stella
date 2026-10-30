import { eq } from "drizzle-orm";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { caseLawSources, publishedCaseLawDecisions } from "@/api/db/schema";
import { corpusStorageMode } from "@/api/env-base";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { readCachedDecisionAst } from "@/api/lib/case-law/decision-ast-cache";
import { parseCachedDecisionAst } from "@/api/lib/case-law/decision-ast-normalization";
import {
  type DecisionPayloadRead,
  readDecisionVersionedPayload,
} from "@/api/lib/case-law/decision-versioned-payload";
import { pgTimestampCursorValue } from "@/api/lib/db-pagination";
import {
  parsePersistedCorpusAst,
  readCorpusPayloadOrFallback,
} from "@/api/lib/legal-search/corpus-storage";
import type { CorpusTombstoneReader } from "@/api/lib/legal-search/corpus-tombstones";
import type { EmptyAst } from "@/api/lib/legal-search/document-types";
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
  updatedAt: publishedCaseLawDecisions.updatedAt,
  versionTimestamp: pgTimestampCursorValue(publishedCaseLawDecisions.updatedAt),
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

type DecisionAnalysisAstVersion = {
  decisionId: SafeId<"caseLawDecision">;
  versionTimestamp: string;
  contentHash: string | null;
  astS3Key: string | null;
};

export type DecisionAnalysisAstColumnRead = DecisionPayloadRead<"documentAst">;

/** Lazy fallback: metadata reads do not transfer an AST served by storage. */
export const readDecisionAnalysisAstColumn = async (
  tx: CaseLawPublicReadTransaction,
  { decisionId, ...version }: DecisionAnalysisAstVersion,
): Promise<DecisionAnalysisAstColumnRead> =>
  await readDecisionVersionedPayload(
    tx,
    { id: decisionId, ...version },
    "documentAst",
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
  readPgAst?: () => Promise<DocumentAst | EmptyAst | null>,
): Promise<DocumentAst | null> => {
  const readRowAst = async () =>
    readPgAst === undefined
      ? parsePersistedCorpusAst(documentAst, id)
      : await readPgAst();
  if (
    corpusStorageMode === "off" ||
    astS3Key === null ||
    contentHash === null
  ) {
    return parseCachedDecisionAst(await readRowAst());
  }
  const stored = await readCorpusPayloadOrFallback({
    documentId: id,
    key: astS3Key,
    step: "analysis.readDecisionAst",
    read: async () => await readCachedDecisionAst(astS3Key, readTombstones),
    fallback: readRowAst,
  });
  return parseCachedDecisionAst(stored);
};
