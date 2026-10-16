import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import { decisionDocketGrammarForJurisdiction } from "@stll/api-contract/decision-docket-grammar";
import { readDecisionDocketReference } from "@stll/api-contract/decision-docket-reference";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { sha256Hex } from "@stll/sha256/bun";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import {
  decisionIdsNamedBy,
  docketFamilyKeyToRead,
} from "@/api/handlers/case-law/decisions/lookup-by-identity";
import type { DecisionIdentityLocator } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { readPublicDecisionLanguageAlternatesInTx } from "@/api/lib/case-law/language-alternates";
import { publishedCaseLawDecision } from "@/api/lib/case-law/published-decisions";
import { redistributableCaseLawSourceFor } from "@/api/lib/case-law/redistribution-sql";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";

type CaseFileSubject = Pick<
  typeof caseLawDecisions.$inferSelect,
  | "caseNumber"
  | "caseNumberType"
  | "country"
  | "court"
  | "courtId"
  | "sourceId"
  | "language"
  | "languageGroupKey"
>;

/** A file is bound into its cursor so a cursor cannot continue another file. */
export const decodeCaseFileCursor = (
  cursor: string | null | undefined,
  fileKey: string,
): string | null | false => {
  if (cursor === null || cursor === undefined) {
    return null;
  }
  const parts = decodePaginationCursor(cursor);
  const documentKey = parts?.at(1);
  return parts?.length === 2 &&
    parts.at(0) === fileKey &&
    typeof documentKey === "string"
    ? documentKey
    : false;
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
    .select({ court: caseLawDecisions.court })
    .from(caseLawDecisions)
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(
      and(
        eq(caseLawDecisions.sourceId, decision.sourceId),
        publishedCaseLawDecision,
        isNull(caseLawDecisions.redactedAt),
        redistributableCaseLawSourceFor(caseLawSources.descriptor),
        eq(caseLawDecisions.country, decision.country),
        decision.languageGroupKey === null
          ? eq(caseLawDecisions.court, decision.court)
          : eq(caseLawDecisions.languageGroupKey, decision.languageGroupKey),
      ),
    );
  const documentKey = sql<string>`CASE
    WHEN ${caseLawDecisions.languageGroupKey} IS NULL THEN 'document:' || ${caseLawDecisions.id}::text
    ELSE 'language:' || ${caseLawDecisions.languageGroupKey}
  END`;
  const versions = tx
    .select({
      id: caseLawDecisions.id,
      caseNumber: caseLawDecisions.caseNumber,
      country: caseLawDecisions.country,
      court: caseLawDecisions.court,
      decisionDate: caseLawDecisions.decisionDate,
      decisionType: caseLawDecisions.decisionType,
      ecli: caseLawDecisions.ecli,
      language: caseLawDecisions.language,
      languageGroupKey: caseLawDecisions.languageGroupKey,
      slug: caseLawDecisions.slug,
      documentKey:
        sql<string>`min(${caseLawDecisions.id}::text) over (partition by ${documentKey})`.as(
          "document_key",
        ),
      versionRank:
        sql<number>`row_number() over (partition by ${documentKey} order by (${caseLawDecisions.language} = ${decision.language}) desc, ${caseLawDecisions.language}, ${caseLawDecisions.id})`.as(
          "version_rank",
        ),
    })
    .from(caseLawDecisions)
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(
      and(
        inArray(
          caseLawDecisions.id,
          decisionIdsNamedBy({
            country: decision.country,
            familyKey,
            locator,
            tx,
          }),
        ),
        eq(caseLawDecisions.country, decision.country),
        decision.courtId !== null
          ? eq(caseLawDecisions.courtId, decision.courtId)
          : // sql-perf-allow: bounded by indexed decisionIdsNamedBy membership for this one docket
            or(
              eq(caseLawDecisions.court, decision.court),
              inArray(caseLawDecisions.court, localizedCourts),
            ),
        publishedCaseLawDecision,
        isNull(caseLawDecisions.redactedAt),
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
