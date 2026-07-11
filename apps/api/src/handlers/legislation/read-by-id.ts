import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { ScopedDb } from "@/api/db/safe-db";
import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import {
  readCorpusAst,
  readCorpusText,
} from "@/api/handlers/case-law/corpus-storage";
import type { EmptyAst } from "@/api/handlers/case-law/ingestion/adapter";
import { redistributableLegislationSource } from "@/api/handlers/legislation/redistribution";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";

/**
 * Read one legislation document for display. Prefers canonical text/AST
 * from object storage when enabled, falling back to the Postgres columns
 * (mirrors case-law read-by-id). Global corpus tables are readable by the
 * scoped role, so reads go through scopedDb.
 */
export const readLegislationHandler = async (
  documentId: SafeId<"legislationDocument">,
  scopedDb: ScopedDb,
) => {
  const [document] = await scopedDb((tx) =>
    tx
      .select({
        id: legislationDocuments.id,
        eli: legislationDocuments.eli,
        title: legislationDocuments.title,
        country: legislationDocuments.country,
        language: legislationDocuments.language,
        documentType: legislationDocuments.documentType,
        status: legislationDocuments.status,
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
      .innerJoin(
        legislationSources,
        eq(legislationSources.id, legislationDocuments.sourceId),
      )
      .where(
        and(
          eq(legislationDocuments.id, documentId),
          redistributableLegislationSource,
        ),
      )
      .limit(1),
  );

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

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "legal_corpus_admin" },
  params: t.Object({ documentId: tSafeId("legislationDocument") }),
} satisfies HandlerConfig;

const readLegislation = createSafeRootHandler(
  config,
  async function* ({ params: { documentId }, scopedDb }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await readLegislationHandler(documentId, scopedDb),
      ),
    );
    return Result.ok(response);
  },
);

export default readLegislation;
