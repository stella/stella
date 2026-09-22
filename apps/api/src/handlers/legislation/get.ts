import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import {
  caseLawStatuteCitationCountState,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import {
  statuteCitationCaseCount,
  statuteCitationCountStateJoin,
} from "@/api/handlers/legislation/citation-count";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  derivedAiLegislationSource,
  publishedLegislationDocument,
} from "@/api/lib/legal-search/legislation-redistribution";
import {
  readVersionAst,
  readVersionText,
  versionAstColumns,
  versionTextColumns,
} from "@/api/lib/legal-search/legislation-version-blocks";
import {
  legislationPublicReadDb,
  type LegislationReadDb,
} from "@/api/lib/legislation-public-read-db";

const LEGISLATION_TEXT_MODE = {
  ALWAYS: "always",
  FALLBACK: "fallback",
} as const;

type LegislationTextMode =
  (typeof LEGISLATION_TEXT_MODE)[keyof typeof LEGISLATION_TEXT_MODE];

type ReadLegislationOptions = {
  /** Controls the response projection, never corpus publication permission. */
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
          // `id` first, as the response has always carried it; the Postgres
          // payload copies it brings along are only projected for a row
          // object storage does not serve, since for a large code they are
          // megabytes the reader would discard.
          ...versionAstColumns,
          ...versionTextColumns,
          eli: legislationDocuments.eli,
          slug: legislationDocuments.slug,
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
          citationCaseCount: statuteCitationCaseCount.as("citation_case_count"),
          // Whether the publisher permits AI use of this wording, read off
          // the joined source in the same row rather than by a second query.
          // Displaying source wording and feeding it to a model are separate
          // permissions, so a reader that only renders the text ignores this
          // while an agent read withholds the text when it is false.
          allowsDerivedAi: derivedAiLegislationSource,
          ...(options.audience === "workspace"
            ? { metadata: legislationDocuments.metadata }
            : {}),
        })
        .from(legislationDocuments)
        .innerJoin(
          legislationSources,
          eq(legislationSources.id, legislationDocuments.sourceId),
        )
        .leftJoin(
          caseLawStatuteCitationCountState,
          statuteCitationCountStateJoin,
        )
        .where(
          and(
            eq(legislationDocuments.id, documentId),
            publishedLegislationDocument,
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

  const documentAst = await readVersionAst({
    row: { id: documentId, astS3Key, documentAst: pgAst },
    legislationDb,
    step: "readLegislation.corpusAst",
  });

  const fulltext =
    options.textMode === LEGISLATION_TEXT_MODE.ALWAYS ||
    !hasUsableAst(documentAst)
      ? await readVersionText({
          row: { id: documentId, textS3Key, fulltext: pgText },
          legislationDb,
          step: "readLegislation.corpusText",
        })
      : null;

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
    "version-validity dates, source links, full text, and parsed " +
    "structure. Only documents from sources cleared for redistribution are " +
    "returned; anything else reads as not found.",
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "read_statute" },
  access: "read",
  params: t.Object({ documentId: tSafeId("legislationDocument") }),
} satisfies HandlerConfig;

const readLegislation = createSafeRootHandler(
  config,
  async function* ({ params: { documentId } }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readPublicLegislationHandler(
            documentId,
            legislationPublicReadDb,
          ),
      ),
    );
    return Result.ok(response);
  },
);

export default readLegislation;
