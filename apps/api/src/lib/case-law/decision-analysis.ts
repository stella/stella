import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { parseUsableDocumentAst } from "@stll/legal-ast/document-ast";

import { corpusStorageMode } from "@/api/env-base";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import {
  readCorpusAst,
  readCorpusPayloadOrFallback,
} from "@/api/lib/legal-search/corpus-storage";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";

const decisionAnalysisColumns = {
  id: true,
  language: true,
  court: true,
  country: true,
  decisionType: true,
  documentAst: true,
  analysis: true,
  // Object-storage pointers: under canonical corpus storage the row's own
  // `documentAst` is trimmed and the object is the document.
  astS3Key: true,
  contentHash: true,
  // The rest identifies the document to its publisher, for the
  // development-only re-parse on read (`decisions/dev-reparse.ts`).
  caseNumber: true,
  ecli: true,
  decisionDate: true,
  documentUrl: true,
  metadata: true,
} as const;

export const readDecisionAnalysis = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawAnalysis,
  async (
    tx: CaseLawPublicReadTransaction,
    decisionId: SafeId<"caseLawDecision">,
  ) =>
    await tx.query.caseLawDecisions.findFirst({
      where: { id: { eq: decisionId } },
      columns: decisionAnalysisColumns,
      // `descriptor` carries the source's reuse terms and is read only to
      // decide whether the text may be fed to a model; it is never returned.
      with: { source: { columns: { adapterKey: true, descriptor: true } } },
    }),
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
 */
export const readDecisionAnalysisAst = async ({
  astS3Key,
  contentHash,
  documentAst,
  id,
}: DecisionAstPointers): Promise<DocumentAst | null> => {
  if (
    corpusStorageMode === "off" ||
    astS3Key === null ||
    contentHash === null
  ) {
    return parseUsableDocumentAst(documentAst);
  }
  const stored = await readCorpusPayloadOrFallback({
    documentId: id,
    key: astS3Key,
    step: "analysis.readDecisionAst",
    read: async () => await readCorpusAst(astS3Key),
    fallback: async () => await Promise.resolve(documentAst),
  });
  return parseUsableDocumentAst(stored);
};
