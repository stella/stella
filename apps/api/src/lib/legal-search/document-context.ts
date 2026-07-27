import { rootDb } from "@/api/db/root";
import { corpusStorageMode } from "@/api/env-base";
import {
  readCorpusAst,
  readCorpusPayloadOrFallback,
  readCorpusText,
} from "@/api/handlers/case-law/corpus-storage";
import type { SafeId } from "@/api/lib/branded-types";
import type { LegalDocumentContext } from "@/api/lib/legal-search/types";

/**
 * Canonical text + AST for a decision, for the AI reader. Prefers object
 * storage when enabled, degrading to the Postgres columns on a transient
 * S3 failure so a read is never harder than today. A row with no Postgres
 * copy has nothing to degrade to and surfaces the failure instead. Global
 * corpus data, so it reads via rootDb.
 */
export const loadDocumentContext = async (
  decisionId: SafeId<"caseLawDecision">,
): Promise<LegalDocumentContext | null> => {
  const decision = await rootDb.query.caseLawDecisions.findFirst({
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
  });

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
