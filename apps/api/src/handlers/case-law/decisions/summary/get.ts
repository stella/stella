import { panic } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import type { CaseLawDecisionSummary } from "@stll/api-contract/case-law-decision-summary";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import {
  caseLawDecisionIdentifiers,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import { createSafePublicSubjectHandler } from "@/api/handlers/case-law/decisions/public-subject";
import {
  ACCOUNT_ACCESS,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import {
  type CaseLawPublicReadDb,
  caseLawPublicReadDb,
} from "@/api/lib/case-law-public-read-db";
import {
  courtPresentation,
  readCourtRegistry,
} from "@/api/lib/case-law/court-presentation";
import { readDecisionHeadnote } from "@/api/lib/case-law/decision-text";
import { loadPublicCourtWeightsWithin } from "@/api/lib/case-law/public-case-law-config";
import type { RedistributableDecisionSubject } from "@/api/lib/case-law/public-subject";
import {
  publisherHeadnoteMetadataSql,
  publisherKeywordsMetadataSql,
} from "@/api/lib/case-law/publisher-summary";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

import {
  decisionSummaryResponseSchema,
  projectDecisionSummary,
} from "../summary-response";

const DECISION_SUMMARY_COLUMNS = {
  id: publishedCaseLawDecisions.id,
  caseNumber: publishedCaseLawDecisions.caseNumber,
  court: publishedCaseLawDecisions.court,
  courtId: publishedCaseLawDecisions.courtId,
  country: publishedCaseLawDecisions.country,
  decisionDate: publishedCaseLawDecisions.decisionDate,
  decisionType: publishedCaseLawDecisions.decisionType,
  headnote: publisherHeadnoteMetadataSql(publishedCaseLawDecisions.metadata),
  keywords: publisherKeywordsMetadataSql(publishedCaseLawDecisions.metadata),
  citationCount: publishedCaseLawDecisions.citationCount,
};

type PublishedDecisionRow = typeof publishedCaseLawDecisions.$inferSelect;
// The metadata expressions select only publisher headnote/keywords; neither
// the rest of metadata nor document bodies belong in a hover-card read.
type SummaryDecisionSource = Omit<
  typeof DECISION_SUMMARY_COLUMNS,
  "headnote" | "keywords"
> &
  Pick<PublishedDecisionRow, "metadata">;
const UNSELECTED_SUMMARY_COLUMNS = [
  // Publisher identity and alternate addressing are available on the full read.
  "sourceId",
  "caseNumberType",
  "citationKey",
  "docketFamilyKey",
  "slug",
  "ecli",
  "language",
  "languageGroupKey",
  "sourceUrl",
  "documentUrl",
  "sourceDocumentId",
  "sheetNumber",
  // Documents, raw observations and analysis are deliberately never loaded by hover.
  "fulltext",
  "sections",
  "documentAst",
  "analysis",
  "parserVersion",
  "sourceRaw",
  "sourceRawS3Key",
  "sourceRawContentType",
  "textS3Key",
  "normalizedS3Key",
  "astS3Key",
  // Ingestion, publication and indexing lifecycle stays on the server.
  "textlessDetailRecheckedAt",
  "documentFetchRequestedAt",
  "documentFetchAttemptedAt",
  "documentFetchAttempts",
  "sourceHash",
  "sourceHashVersion",
  "parsedSourceHash",
  "parsedSourceHashVersion",
  "parsedSourceRawS3Key",
  "sourceObservedAt",
  "sourceObservationOrder",
  "sourceObservationHash",
  "redactedAt",
  "corpusMirrorStatus",
  "citationAuthority",
  "citationAuthorityComputedAt",
  "contentHash",
  "indexedHash",
  "indexedGeneration",
  "indexedAt",
  "projectionEpoch",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof PublishedDecisionRow)[];
type MissingSummarySourceColumn = UnprojectedColumns<
  PublishedDecisionRow,
  SummaryDecisionSource,
  (typeof UNSELECTED_SUMMARY_COLUMNS)[number]
>;
type UnexpectedSummarySourceColumn = UnbackedProjectionKeys<
  PublishedDecisionRow,
  SummaryDecisionSource,
  (typeof UNSELECTED_SUMMARY_COLUMNS)[number]
>;
true satisfies MissingSummarySourceColumn extends never ? true : never;
true satisfies UnexpectedSummarySourceColumn extends never ? true : never;

const REPORTER_PUBLICATION_COLUMNS = {
  value: caseLawDecisionIdentifiers.value,
};
type ReporterIdentifierRow = typeof caseLawDecisionIdentifiers.$inferSelect;
const UNSELECTED_REPORTER_COLUMNS = [
  // The gated decision and fixed reporter type are query predicates, not card fields.
  "decisionId",
  "type",
  // Normalization, alias provenance and ingestion time do not describe the publication.
  "normalizedValue",
  "declaredAt",
  "createdAt",
] as const satisfies readonly (keyof ReporterIdentifierRow)[];
type MissingReporterColumn = UnprojectedColumns<
  ReporterIdentifierRow,
  typeof REPORTER_PUBLICATION_COLUMNS,
  (typeof UNSELECTED_REPORTER_COLUMNS)[number]
>;
type UnexpectedReporterColumn = UnbackedProjectionKeys<
  ReporterIdentifierRow,
  typeof REPORTER_PUBLICATION_COLUMNS,
  (typeof UNSELECTED_REPORTER_COLUMNS)[number]
>;
true satisfies MissingReporterColumn extends never ? true : never;
true satisfies UnexpectedReporterColumn extends never ? true : never;

/** A bounded, stored-only projection for citation cards. */
const readDecisionSummary = async (
  subject: RedistributableDecisionSubject,
): Promise<CaseLawDecisionSummary> => {
  const [decision, publication, courtWeights] = await Promise.all([
    subject.tx
      .select(DECISION_SUMMARY_COLUMNS)
      .from(publishedCaseLawDecisions)
      .where(eq(publishedCaseLawDecisions.id, subject.id))
      .limit(1)
      .then((rows) => rows.at(0)),
    subject.tx
      .select(REPORTER_PUBLICATION_COLUMNS)
      .from(caseLawDecisionIdentifiers)
      .where(
        and(
          eq(caseLawDecisionIdentifiers.decisionId, subject.id),
          eq(
            caseLawDecisionIdentifiers.type,
            DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
          ),
        ),
      )
      .limit(1)
      .then((rows) => rows.at(0)),
    readCourtRegistry(
      async () => await loadPublicCourtWeightsWithin(subject.tx),
    ),
  ]);

  // The public-subject gate found this row in the same transaction.
  if (decision === undefined) {
    return panic("Gated case-law decision disappeared during summary read");
  }
  const presentation = courtPresentation(courtWeights, decision);
  return projectDecisionSummary({
    id: decision.id,
    caseNumber: decision.caseNumber,
    court: decision.court,
    courtAbbreviation: presentation.courtAbbreviation,
    courtTier: presentation.courtTier,
    decisionDate: decision.decisionDate,
    decisionType: decision.decisionType,
    headnote: readDecisionHeadnote({
      headnote: decision.headnote,
      keywords: decision.keywords,
    }),
    citationCount: decision.citationCount,
    publication: publication?.value ?? null,
  });
};

export const createReadDecisionSummaryHandler = (
  caseLawDb: CaseLawPublicReadDb = caseLawPublicReadDb,
) =>
  createSafePublicSubjectHandler({
    config: {
      contract: "patch",
      access: "read",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "search_ui" },
      cache: { kind: "none" },
      params: v.object({ decisionId: resourceIdSchema("caseLawDecision") }),
      response: safePublicHandlerResponseSchemasWithStatusText(
        decisionSummaryResponseSchema,
      ),
    },
    caseLawDb,
    locate: ({ params: { decisionId } }) => ({ kind: "id", id: decisionId }),
    read: readDecisionSummary,
  });

const readDecisionSummaryRoute = createReadDecisionSummaryHandler();

export default readDecisionSummaryRoute;
