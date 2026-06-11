import { rootDb } from "@/api/db/root";
import { envBase } from "@/api/env-base";
import {
  readCorpusAst,
  readCorpusText,
} from "@/api/handlers/case-law/corpus-storage";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import type { LegalDocumentContext } from "@/api/lib/legal-search/types";

/**
 * Canonical text + AST for a decision, for the AI reader. Prefers object
 * storage when enabled, falling back to the Postgres columns (and on a
 * transient S3 failure) so a read is never harder than today. Global
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

  const corpus = envBase.CORPUS_STORAGE_ENABLED;

  let documentAst = decision.documentAst;
  if (corpus && decision.astS3Key !== null) {
    try {
      documentAst = await readCorpusAst(decision.astS3Key);
    } catch (error) {
      captureError(error, { decisionId, step: "documentContext.corpusAst" });
    }
  }

  let fulltext = decision.fulltext;
  if (corpus && decision.textS3Key !== null) {
    try {
      fulltext = await readCorpusText(decision.textS3Key);
    } catch (error) {
      captureError(error, { decisionId, step: "documentContext.corpusText" });
    }
  }

  return {
    decisionId: decision.id,
    caseNumber: decision.caseNumber,
    court: decision.court,
    fulltext,
    documentAst,
  };
};
