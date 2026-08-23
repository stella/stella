import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { hasUsableAst } from "@stll/legal-ast/document-ast";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { corpusStorageMode } from "@/api/env-base";
import { redistributableLegislationSource } from "@/api/handlers/legislation/redistribution";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  readCorpusAst,
  readCorpusPayloadOrFallback,
  readCorpusText,
  parsePersistedCorpusAst,
} from "@/api/lib/legal-search/corpus-storage";
import type { EmptyAst } from "@/api/lib/legal-search/document-types";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";

const LEGISLATION_TEXT_MODE = {
  ALWAYS: "always",
  FALLBACK: "fallback",
} as const;

type LegislationTextMode =
  (typeof LEGISLATION_TEXT_MODE)[keyof typeof LEGISLATION_TEXT_MODE];

type ReadLegislationOptions = {
  audience: "public" | "workspace";
  textMode: LegislationTextMode;
};

const DEFAULT_READ_OPTIONS = {
  audience: "workspace",
  textMode: LEGISLATION_TEXT_MODE.ALWAYS,
} as const satisfies ReadLegislationOptions;

const PUBLIC_READ_OPTIONS = {
  audience: "public",
  textMode: LEGISLATION_TEXT_MODE.FALLBACK,
} as const satisfies ReadLegislationOptions;

/**
 * Read one legislation document for display. Prefers canonical text/AST
 * from object storage when enabled, falling back to the Postgres columns
 * (mirrors case-law read-by-id). The corpus tables are global, so the same
 * read serves the workspace route and the public reader; the caller passes
 * the database handle its own boundary allows.
 */
export const readLegislationHandler = async (
  documentId: SafeId<"legislationDocument">,
  legislationDb: LegislationReadDb,
  options: ReadLegislationOptions = DEFAULT_READ_OPTIONS,
) => {
  const [document] = await legislationDb(
    async (tx) =>
      await tx
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
          sections: legislationDocuments.sections,
          sourceUrl: legislationDocuments.sourceUrl,
          documentUrl: legislationDocuments.documentUrl,
          createdAt: legislationDocuments.createdAt,
          updatedAt: legislationDocuments.updatedAt,
          documentAst: legislationDocuments.documentAst,
          fulltext: legislationDocuments.fulltext,
          astS3Key: legislationDocuments.astS3Key,
          textS3Key: legislationDocuments.textS3Key,
          ...(options.audience === "workspace"
            ? { metadata: legislationDocuments.metadata }
            : {}),
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

  const corpus = corpusStorageMode !== "off";

  const documentAst: DocumentAst | EmptyAst | null =
    corpus && astS3Key !== null
      ? await readCorpusPayloadOrFallback({
          documentId,
          key: astS3Key,
          step: "readLegislation.corpusAst",
          read: async () => await readCorpusAst(astS3Key),
          fallback: () => parsePersistedCorpusAst(pgAst),
        })
      : parsePersistedCorpusAst(pgAst);

  let fulltext: string | null = null;
  if (
    options.textMode === LEGISLATION_TEXT_MODE.ALWAYS ||
    !hasUsableAst(documentAst)
  ) {
    fulltext = pgText;
    if (corpus && textS3Key !== null) {
      fulltext = await readCorpusPayloadOrFallback({
        documentId,
        key: textS3Key,
        step: "readLegislation.corpusText",
        read: async () => await readCorpusText(textS3Key),
        fallback: () => pgText,
      });
    }
  }

  return { ...rest, documentAst, fulltext };
};

/**
 * The unauthenticated reader's projection. `metadata` is an open JSONB bag
 * filled from whatever the publisher shipped, so it stays on the
 * workspace-scoped read and never reaches a public response.
 */
export const readPublicLegislationHandler = async (
  documentId: SafeId<"legislationDocument">,
  legislationDb: LegislationReadDb,
) => {
  const document = await readLegislationHandler(
    documentId,
    legislationDb,
    PUBLIC_READ_OPTIONS,
  );

  if (!("metadata" in document)) {
    return document;
  }

  const { metadata: _metadata, ...publicFields } = document;

  return publicFields;
};

const config = {
  description:
    "Read one legislation document from the stella corpus by id: its ELI, " +
    "title, country, language, document type, status, effective and " +
    "version-validity dates, source links, metadata, full text, and parsed " +
    "structure. Only documents from sources cleared for redistribution are " +
    "returned; anything else reads as not found.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "legal_corpus_admin" },
  access: "read",
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
