import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import type { PublicCountrySurface } from "@stll/api-contract/public-country-capability";
import { hasUsableAst } from "@stll/legal-ast/document-ast";
import { todayFor } from "@stll/time";

import {
  caseLawStatuteCitationCountState,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import {
  statuteCitationCaseCount,
  statuteCitationCountStateJoin,
} from "@/api/handlers/legislation/citation-count";
import {
  projectStatuteAmendments,
  projectStatuteReader,
} from "@/api/handlers/legislation/reader-response";
import { status } from "@/api/http/status";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import {
  LEGISLATION_AMENDMENT_PAGE_MAX,
  readLegislationAmendments,
  readLegislationAmendmentSnapshot,
} from "@/api/lib/legal-search/legislation-amendments";
import { legislationExpressionLabelColumns } from "@/api/lib/legal-search/legislation-expression-label";
import {
  derivedAiLegislationSource,
  publishedLegislationDocumentFor,
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

const amendmentLegalDayTimeZone = (country: string): string => {
  switch (country) {
    case "CZE":
      return "Europe/Prague";
    case "SVK":
      return "Europe/Bratislava";
    default:
      return panic("Amendment source has no legal-day time zone");
  }
};

/**
 * Read one legislation document for display. Prefers canonical text/AST
 * from object storage when enabled, falling back to the Postgres columns
 * (mirrors case-law read-by-id). Full text is read only when the AST is
 * unusable. The corpus tables are global, so the same read serves the
 * authenticated route, the public reader and agent tools; the caller passes
 * the database handle its own boundary allows. `metadata` is an open JSONB
 * bag filled from whatever the publisher shipped, so it is never projected.
 */
export const readPublicLegislationHandler = async (
  documentId: SafeId<"legislationDocument">,
  legislationDb: LegislationReadDb,
  surface: PublicCountrySurface,
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
          sourceId: legislationDocuments.sourceId,
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
          ...legislationExpressionLabelColumns,
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
            publishedLegislationDocumentFor(surface),
          ),
        )
        .limit(1),
  );

  if (!document) {
    return status(404, { message: "Legislation document not found" });
  }

  const pendingChanges = await legislationDb(async (tx) => {
    const work = {
      sourceId: document.sourceId,
      eli: document.eli,
      language: document.language,
    };
    const snapshot = await readLegislationAmendmentSnapshot(tx, work);
    if (snapshot === null) {
      return null;
    }
    const timeZone = amendmentLegalDayTimeZone(document.country);
    const page = await readLegislationAmendments(tx, {
      work,
      direction: "incoming",
      limit: LEGISLATION_AMENDMENT_PAGE_MAX,
      effectiveAfter: todayFor(timeZone).toString(),
    });
    return projectStatuteAmendments({ page, snapshot });
  });

  const {
    sourceId: _sourceId,
    astS3Key,
    textS3Key,
    documentAst: pgAst,
    fulltext: pgText,
    ...rest
  } = document;

  const documentAst = await readVersionAst({
    surface,
    row: { id: documentId, astS3Key, documentAst: pgAst },
    legislationDb,
    step: "readLegislation.corpusAst",
  });

  const fulltext = hasUsableAst(documentAst)
    ? null
    : await readVersionText({
        surface,
        row: { id: documentId, textS3Key, fulltext: pgText },
        legislationDb,
        step: "readLegislation.corpusText",
      });

  return projectStatuteReader({
    ...rest,
    pendingChanges,
    documentAst,
    fulltext,
  });
};

const config = {
  contract: "patch",
  description:
    "Read one legislation document from the stella corpus by id: its ELI, " +
    "title, country, language, document type, status, effective and " +
    "version-validity dates, source links, and parsed structure. Full text " +
    "is returned only when the parsed structure is missing or unusable, and " +
    "is null otherwise. Only documents from sources cleared for " +
    "redistribution are returned; anything else reads as not found.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "covered", by: "read_statute" },
  access: "read",
  params: v.object({ documentId: resourceIdSchema("legislationDocument") }),
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
            "pages",
          ),
      ),
    );
    return Result.ok(response);
  },
);

export default readLegislation;
