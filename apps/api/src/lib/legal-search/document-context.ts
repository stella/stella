import { corpusStorageMode } from "@/api/env-base";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import {
  readCorpusAst,
  readCorpusPayloadOrFallback,
  readCorpusText,
} from "@/api/lib/legal-search/corpus-storage";
import type { LegalDocumentContext } from "@/api/lib/legal-search/types";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";

export const readDocumentContextDecision = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawDocumentContext,
  async (
    tx: CaseLawPublicReadTransaction,
    decisionId: SafeId<"caseLawDecision">,
  ) =>
    await tx.query.caseLawDecisions.findFirst({
      where: { id: { eq: decisionId } },
      columns: {
        id: true,
        caseNumber: true,
        court: true,
        documentAst: true,
        fulltext: true,
        astS3Key: true,
        textS3Key: true,
      },
    }),
);

/**
 * Canonical text + AST for a decision, for the AI reader. Prefers object
 * storage when enabled, degrading to the Postgres columns on a transient
 * S3 failure so a read is never harder than today. A row with no Postgres
 * copy has nothing to degrade to and surfaces the failure instead. The
 * public-corpus read boundary may resolve to a separately credentialed,
 * read-only database.
 */
export const loadDocumentContext = async (
  decisionId: SafeId<"caseLawDecision">,
): Promise<LegalDocumentContext | null> => {
  const decision = await caseLawPublicReadDb(
    async (tx) => await readDocumentContextDecision(tx, decisionId),
  );

  if (!decision) {
    return null;
  }

  const corpus = corpusStorageMode !== "off";
  const { astS3Key, textS3Key } = decision;

  const documentAst =
    corpus && astS3Key !== null
      ? await readCorpusPayloadOrFallback({
          documentId: decisionId,
          key: astS3Key,
          step: "documentContext.corpusAst",
          read: async () => await readCorpusAst(astS3Key),
          fallback: () => decision.documentAst,
        })
      : decision.documentAst;

  const fulltext =
    corpus && textS3Key !== null
      ? await readCorpusPayloadOrFallback({
          documentId: decisionId,
          key: textS3Key,
          step: "documentContext.corpusText",
          read: async () => await readCorpusText(textS3Key),
          fallback: () => decision.fulltext,
        })
      : decision.fulltext;

  return {
    decisionId: decision.id,
    caseNumber: decision.caseNumber,
    court: decision.court,
    fulltext,
    documentAst,
  };
};
