import { eq } from "drizzle-orm";
import { status } from "elysia";

import type { DocumentAst } from "@stll/case-law/document-ast";

import { rootDb } from "@/api/db/root";
import { legislationDocuments } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import {
  readCorpusAst,
  readCorpusText,
} from "@/api/handlers/case-law/corpus-storage";
import type { EmptyAst } from "@/api/handlers/case-law/ingestion/adapter";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * Read one legislation document for display. Prefers canonical text/AST
 * from object storage when enabled, falling back to the Postgres columns
 * (mirrors case-law read-by-id). Global corpus → reads via rootDb.
 */
export const readLegislationHandler = async (
  documentId: SafeId<"legislationDocument">,
) => {
  const [document] = await rootDb
    .select({
      id: legislationDocuments.id,
      eli: legislationDocuments.eli,
      title: legislationDocuments.title,
      country: legislationDocuments.country,
      language: legislationDocuments.language,
      documentType: legislationDocuments.documentType,
      statusValue: legislationDocuments.status,
      effectiveDate: legislationDocuments.effectiveDate,
      versionValidFrom: legislationDocuments.versionValidFrom,
      versionValidTo: legislationDocuments.versionValidTo,
      sourceUrl: legislationDocuments.sourceUrl,
      documentUrl: legislationDocuments.documentUrl,
      metadata: legislationDocuments.metadata,
      createdAt: legislationDocuments.createdAt,
      updatedAt: legislationDocuments.updatedAt,
      documentAst: legislationDocuments.documentAst,
      fulltext: legislationDocuments.fulltext,
      astS3Key: legislationDocuments.astS3Key,
      textS3Key: legislationDocuments.textS3Key,
    })
    .from(legislationDocuments)
    .where(eq(legislationDocuments.id, documentId))
    .limit(1);

  if (!document) {
    return status(404, { message: "Legislation document not found" });
  }

  const {
    astS3Key,
    textS3Key,
    documentAst: pgAst,
    fulltext: pgText,
    ...rest
  } = document;

  const corpus = envBase.CORPUS_STORAGE_ENABLED;

  let documentAst: DocumentAst | EmptyAst | null = pgAst;
  if (corpus && astS3Key !== null) {
    try {
      documentAst = await readCorpusAst(astS3Key);
    } catch (error) {
      captureError(error, { documentId, step: "readLegislation.corpusAst" });
    }
  }

  let fulltext = pgText;
  if (corpus && textS3Key !== null) {
    try {
      fulltext = await readCorpusText(textS3Key);
    } catch (error) {
      captureError(error, { documentId, step: "readLegislation.corpusText" });
    }
  }

  return { ...rest, documentAst, fulltext };
};
