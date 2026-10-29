import { and, eq, gt, inArray, or, sql } from "drizzle-orm";

import { decisionDocketGrammarForJurisdiction } from "@stll/api-contract/decision-docket-grammar";
import { readDecisionDocketReference } from "@stll/api-contract/decision-docket-reference";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { sha256Hex } from "@stll/sha256/bun";

import { caseLawSources, publishedCaseLawDecisions } from "@/api/db/schema";
import {
  decisionIdsNamedBy,
  docketFamilyKeyToRead,
} from "@/api/handlers/case-law/decisions/lookup-by-identity";
import type { DecisionIdentityLocator } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { readPublicDecisionLanguageAlternatesInTx } from "@/api/lib/case-law/language-alternates";
import { redistributableCaseLawSourceFor } from "@/api/lib/case-law/redistribution-sql";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type CaseFileSubject = Pick<
  typeof publishedCaseLawDecisions.$inferSelect,
  | "caseNumber"
  | "caseNumberType"
  | "country"
  | "court"
  | "courtId"
  | "sourceId"
  | "language"
  | "languageGroupKey"
>;

/** The file a case-file cursor was issued for and the last document it named. */
const caseFileCursorParts = (
  cursor: string,
): { fileKey: string; documentKey: string } | null => {
  const parts = decodePaginationCursor(cursor);
  const fileKey = parts?.at(0);
  const documentKey = parts?.at(1);
  return parts?.length === 2 &&
    typeof fileKey === "string" &&
    typeof documentKey === "string"
    ? { fileKey, documentKey }
    : null;
};

/**
 * Whether a cursor has the shape this read issues. The route refuses any
 * other before reading; which file it continues is checked by the read.
 */
export const isCaseFileCursor = (cursor: string): boolean =>
  caseFileCursorParts(cursor) !== null;

/** A file is bound into its cursor so a cursor cannot continue another file. */
export const decodeCaseFileCursor = (
  cursor: string | null | undefined,
  fileKey: string,
): string | null | false => {
  if (cursor === null || cursor === undefined) {
    return null;
  }
  const parts = caseFileCursorParts(cursor);
  return parts?.fileKey === fileKey ? parts.documentKey : false;
};

type ListCaseFileOptions = {
  tx: Pick<CaseLawPublicReadTransaction, "select">;
  decision: CaseFileSubject;
  cursor?: string | null | undefined;
};

/** One document per language group, inside the subject's court. */
export const listCaseFileDocuments = async ({
  tx,
  decision,
  cursor,
}: ListCaseFileOptions) => {
  const grammar = decisionDocketGrammarForJurisdiction(decision.country);
  const reference =
    decision.caseNumberType === DECISION_IDENTIFIER_TYPES.CASE_NUMBER &&
    grammar !== null
      ? readDecisionDocketReference(decision.caseNumber, { grammar })
      : null;
  const empty = {
    items: [],
    nextCursor: null,
    limit: LIMITS.caseLawCaseFilePageSize,
  };
  if (reference === null) {
    return cursor === null || cursor === undefined ? empty : false;
  }
  const locator = {
    kind: "docket",
    value: reference.family.formatted,
    family: reference.family.formatted,
    selector: { kind: "none" },
  } as const satisfies DecisionIdentityLocator;
  const fileKey = sha256Hex(
    JSON.stringify([
      decision.country,
      decision.courtId ?? decision.court,
      reference.family.canonical,
    ]),
  );
  const after = decodeCaseFileCursor(cursor, fileKey);
  if (after === false) {
    return false;
  }
  const familyKey = await docketFamilyKeyToRead({
    country: decision.country,
    locator,
    tx,
  });
  const localizedCourts = tx
    .select({ court: publishedCaseLawDecisions.court })
    .from(publishedCaseLawDecisions)
    .innerJoin(
      caseLawSources,
      eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
    )
    .where(
      and(
        eq(publishedCaseLawDecisions.sourceId, decision.sourceId),
        redistributableCaseLawSourceFor(caseLawSources.descriptor),
        eq(publishedCaseLawDecisions.country, decision.country),
        decision.languageGroupKey === null
          ? eq(publishedCaseLawDecisions.court, decision.court)
          : eq(
              publishedCaseLawDecisions.languageGroupKey,
              decision.languageGroupKey,
            ),
      ),
    );
  const documentKey = sql<string>`CASE
    WHEN ${publishedCaseLawDecisions.languageGroupKey} IS NULL THEN 'document:' || ${publishedCaseLawDecisions.id}::text
    ELSE 'language:' || ${publishedCaseLawDecisions.languageGroupKey}
  END`;
  const versions = tx
    .select({
      id: publishedCaseLawDecisions.id,
      caseNumber: publishedCaseLawDecisions.caseNumber,
      country: publishedCaseLawDecisions.country,
      court: publishedCaseLawDecisions.court,
      decisionDate: publishedCaseLawDecisions.decisionDate,
      decisionType: publishedCaseLawDecisions.decisionType,
      ecli: publishedCaseLawDecisions.ecli,
      language: publishedCaseLawDecisions.language,
      languageGroupKey: publishedCaseLawDecisions.languageGroupKey,
      slug: publishedCaseLawDecisions.slug,
      documentKey:
        sql<string>`min(${publishedCaseLawDecisions.id}::text) over (partition by ${documentKey})`.as(
          "document_key",
        ),
      versionRank:
        sql<number>`row_number() over (partition by ${documentKey} order by (${publishedCaseLawDecisions.language} = ${decision.language}) desc, ${publishedCaseLawDecisions.language}, ${publishedCaseLawDecisions.id})`.as(
          "version_rank",
        ),
    })
    .from(publishedCaseLawDecisions)
    .innerJoin(
      caseLawSources,
      eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
    )
    .where(
      and(
        inArray(
          publishedCaseLawDecisions.id,
          decisionIdsNamedBy({
            country: decision.country,
            familyKey,
            locator,
            tx,
          }),
        ),
        eq(publishedCaseLawDecisions.country, decision.country),
        decision.courtId !== null
          ? eq(publishedCaseLawDecisions.courtId, decision.courtId)
          : // sql-perf-allow: bounded by indexed decisionIdsNamedBy membership for this one docket
            or(
              eq(publishedCaseLawDecisions.court, decision.court),
              inArray(publishedCaseLawDecisions.court, localizedCourts),
            ),
        redistributableCaseLawSourceFor(caseLawSources.descriptor),
      ),
    )
    .as("case_file_versions");
  const rows = await tx
    .select()
    .from(versions)
    .where(
      and(
        eq(versions.versionRank, 1),
        after === null ? undefined : gt(versions.documentKey, after),
      ),
    )
    .orderBy(versions.documentKey)
    .limit(LIMITS.caseLawCaseFilePageSize + 1);
  const page = createCursorPage({
    rows,
    limit: LIMITS.caseLawCaseFilePageSize,
    cursorForItem: (row) => encodePaginationCursor([fileKey, row.documentKey]),
  });
  const alternates = await readPublicDecisionLanguageAlternatesInTx(
    tx,
    page.items.map((row) => row.languageGroupKey),
  );
  return {
    ...page,
    items: page.items.map(
      ({ versionRank: _rank, documentKey: _key, ...row }) => ({
        ...row,
        languageAlternates: alternates
          .alternatesFor(row.languageGroupKey)
          .map(({ language }) => ({ language })),
      }),
    ),
  };
};

// The case-file list carries links and document labels; the detail reader owns
// payloads, provenance, and derived analysis. Classify every stored column so a
// schema addition requires an explicit decision about this public projection.
const UNPROJECTED_CASE_FILE_COLUMNS = [
  // Source ownership scopes the court-name lookup; it is not a document label.
  "sourceId",
  // The file parser already verified that the primary reference is a docket.
  "caseNumberType",
  // Normalized lookup key, not the publisher's reference.
  "citationKey",
  // Internal file membership key; the page displays caseNumber.
  "docketFamilyKey",
  // Court directory identity scopes the read; the link uses court and country.
  "courtId",
  // Whole document text is served by the detail reader.
  "fulltext",
  // Ingestion reconciliation scheduling is not public document metadata.
  "textlessDetailRecheckedAt",
  // Text sections belong to the detail reader.
  "sections",
  // Structured document content belongs to the detail reader.
  "documentAst",
  // Persisted AI analysis is not part of a public document link.
  "analysis",
  // Parser bookkeeping does not describe a case-file document.
  "parserVersion",
  // Raw publisher bytes are not returned in a document list.
  "sourceRaw",
  // Internal object-storage address for publisher bytes.
  "sourceRawS3Key",
  // Internal content decoder hint for publisher bytes.
  "sourceRawContentType",
  // Source attribution is provided by the linked detail reader.
  "sourceUrl",
  // Publisher downloads are provided by the linked detail reader.
  "documentUrl",
  // Publisher ingestion identity; the public link uses id or slug.
  "sourceDocumentId",
  // Fallback identity and cohort bookkeeping are not public document labels.
  "fallbackIdentityKey",
  "fallbackCohortKey",
  "fallbackContentHash",
  "fallbackPublicationHash",
  // The file's document labels use the published primary reference.
  "sheetNumber",
  // Document-fetch queue priority is internal bookkeeping.
  "documentFetchRequestedAt",
  // Document-fetch claim timing is internal bookkeeping.
  "documentFetchAttemptedAt",
  // Document-fetch retry state is internal bookkeeping.
  "documentFetchAttempts",
  // Open publisher metadata is deliberately absent from compact document links.
  "metadata",
  // Source change detection is internal bookkeeping.
  "sourceHash",
  // The fingerprint algorithm version is internal bookkeeping.
  "sourceHashVersion",
  // Which raw generation the stored parse came from is internal bookkeeping.
  "parsedSourceHash",
  "parsedSourceHashVersion",
  "parsedSourceRawS3Key",
  // Source observation timing is internal bookkeeping.
  "sourceObservedAt",
  // Source observation ordering is internal bookkeeping.
  "sourceObservationOrder",
  // Observation replay detection is internal bookkeeping.
  "sourceObservationHash",
  // The published view excludes redacted rows rather than exposing a marker.
  "redactedAt",
  // Corpus replication state is internal bookkeeping.
  "corpusMirrorStatus",
  // Ranking is unrelated to membership in a case file.
  "citationAuthority",
  // Citation counts are not part of document labels.
  "citationCount",
  // Ranking maintenance timing is internal bookkeeping.
  "citationAuthorityComputedAt",
  // Internal object-storage address for document text.
  "textS3Key",
  // Internal object-storage address for normalized source bytes.
  "normalizedS3Key",
  // Internal object-storage address for structured document content.
  "astS3Key",
  // Internal corpus payload identity.
  "contentHash",
  // Retired search projection bookkeeping.
  "indexedHash",
  // Retired search generation bookkeeping.
  "indexedGeneration",
  // Retired search projection timestamp.
  "indexedAt",
  // Search projection concurrency fence is internal bookkeeping.
  "projectionEpoch",
  // Ingestion creation time is not the document's decision date.
  "createdAt",
  // Storage update time is not the document's decision date.
  "updatedAt",
] as const satisfies readonly (keyof typeof publishedCaseLawDecisions.$inferSelect)[];

type CaseFilePage = Exclude<
  Awaited<ReturnType<typeof listCaseFileDocuments>>,
  false
>;
// Language availability is batch-derived from sibling rows. Every other
// response field must trace to a classified decision column.
type CaseFileDocumentColumns = Omit<
  CaseFilePage["items"][number],
  "languageAlternates"
>;
type MissingCaseFileColumn = UnprojectedColumns<
  typeof publishedCaseLawDecisions.$inferSelect,
  CaseFileDocumentColumns,
  (typeof UNPROJECTED_CASE_FILE_COLUMNS)[number]
>;
type UnexpectedCaseFileColumn = UnbackedProjectionKeys<
  typeof publishedCaseLawDecisions.$inferSelect,
  CaseFileDocumentColumns,
  (typeof UNPROJECTED_CASE_FILE_COLUMNS)[number]
>;

true satisfies MissingCaseFileColumn extends never ? true : never;
true satisfies UnexpectedCaseFileColumn extends never ? true : never;
