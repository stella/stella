import { eq } from "drizzle-orm";

import { parseCaseLawDecisionAst } from "@stll/legal-ast/case-law-reader";

import { publishedCaseLawDecisions } from "@/api/db/schema";
import { corpusStorageMode } from "@/api/env-base";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import {
  readCorpusAst,
  readCorpusText,
} from "@/api/lib/legal-search/corpus-reads";
import {
  persistedAstOrAbsent,
  readCorpusPayloadOrFallback,
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
  ) => {
    const [row] = await tx
      .select({
        id: publishedCaseLawDecisions.id,
        caseNumber: publishedCaseLawDecisions.caseNumber,
        court: publishedCaseLawDecisions.court,
        documentAst: publishedCaseLawDecisions.documentAst,
        fulltext: publishedCaseLawDecisions.fulltext,
        astS3Key: publishedCaseLawDecisions.astS3Key,
        textS3Key: publishedCaseLawDecisions.textS3Key,
      })
      .from(publishedCaseLawDecisions)
      .where(eq(publishedCaseLawDecisions.id, decisionId))
      .limit(1);
    return row;
  },
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
          read: async () =>
            persistedAstOrAbsent(
              await readCorpusAst(astS3Key),
              "documentContext.corpusAst",
            ),
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
    documentAst: parseCaseLawDecisionAst(documentAst),
  };
};
