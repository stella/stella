import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import {
  PUBLIC_CASE_LAW_COUNTRIES,
  publicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";
import {
  PROVISION_CITING_DECISION_SORTS,
  PROVISION_CITING_FILTER_LIMITS,
  PROVISION_CITING_SNAPSHOT_LIMIT,
} from "@stll/api-contract/provision-citing-decisions";
import { sha256Hex } from "@stll/sha256/bun";

import {
  caseLawDecisions,
  caseLawProvisionCitations,
  caseLawSources,
} from "@/api/db/schema";
import type {
  CaseLawPublicReadTransaction,
  CaseLawPublicReadDb,
} from "@/api/lib/case-law-public-read-db";
import { courtPresentation } from "@/api/lib/case-law/court-presentation";
import type { CourtRegistry } from "@/api/lib/case-law/court-presentation";
import { readPublicDecisionLanguageAlternatesInTx } from "@/api/lib/case-law/language-alternates";
import { publishedCaseLawDecision } from "@/api/lib/case-law/published-decisions";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import {
  readPublicLawCountry,
  tPublicLawCountry,
} from "@/api/lib/legal-search/public-law-country";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";

import { snippetCitation } from "./snippet-citation";
import {
  PROVISION_VERSION_COLUMNS,
  projectProvisionVersion,
} from "./version-response";

/**
 * The two keys a work is asked about by, and never both at once.
 *
 * `work` is the display citation the corpus records (`89/2012 Sb.`), which is
 * what a decision's own text states. `eli` is the work's identifier, which is
 * what a statute knows itself by — a reader coming from the act has no
 * display citation to offer, and deriving one from the ELI would be guessing
 * at another producer's formatting. Both are indexed keys on the citation
 * table, so either answers from the same access path.
 */
export const listCitingDecisionsQuerySchema = t.Object({
  jurisdiction: tPublicLawCountry,
  work: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
  eli: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
  anchor: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
  limit: t.Optional(
    tPaginationLimit(
      Math.max(
        LIMITS.caseLawSearchPageSizeMax,
        PROVISION_CITING_SNAPSHOT_LIMIT,
      ),
    ),
  ),
  cursor: t.Optional(tPaginationCursor()),
  // A spread of mapped literals widens the union's static type to `never`;
  // the derived enum keeps the contract's sorts and stays undefined when absent.
  sort: t.Optional(
    t.Enum(
      Object.fromEntries(
        [...PROVISION_CITING_DECISION_SORTS, "authority" as const].map(
          (sort) => [sort, sort] as const,
        ),
      ),
    ),
  ),
  court: t.Optional(
    t.String({
      minLength: 1,
      maxLength: PROVISION_CITING_FILTER_LIMITS.courtChars,
    }),
  ),
  year: t.Optional(
    t.Integer({
      minimum: PROVISION_CITING_FILTER_LIMITS.yearMin,
      maximum: PROVISION_CITING_FILTER_LIMITS.yearMax,
    }),
  ),
  /** Require a readable excerpt rather than relationship metadata alone. */
  excerpt: t.Optional(t.Literal("required")),
});

type ListCitingDecisionsQuery = Static<typeof listCitingDecisionsQuerySchema>;

/**
 * Which column the work filter reads, refused when the request names neither
 * key or both: an unfiltered walk of a jurisdiction is not a page of one
 * work's case law, and two filters at once is a request that does not know
 * what it is asking.
 */
const workCondition = (query: ListCitingDecisionsQuery): SQL | null => {
  if (query.work !== undefined && query.eli !== undefined) {
    return null;
  }

  if (query.work !== undefined) {
    return eq(caseLawProvisionCitations.workIdentifier, query.work);
  }

  if (query.eli !== undefined) {
    return eq(caseLawProvisionCitations.workEli, query.eli);
  }

  return null;
};

/** A null date sorts last under the shared descending order. */
const DECISION_DATE_FLOOR = "0001-01-01";

const decisionDateKeySql = sql`coalesce(${caseLawProvisionCitations.decisionDate}, ${DECISION_DATE_FLOOR}::date)`;
const decisionDateCursorSql = sql<string>`to_char(${decisionDateKeySql}, 'YYYY-MM-DD')`;

type CitingDecisionsCursor = {
  context: string;
  decisionDate: string;
  decisionId: string;
};

const decodeCitingDecisionsCursor = (
  cursor: string,
): CitingDecisionsCursor | null => {
  const parts = decodePaginationCursor(cursor);
  if (parts?.length !== 3) {
    return null;
  }
  const [context, decisionDate, decisionId] = parts;
  if (
    typeof context !== "string" ||
    !/^[a-f0-9]{64}$/u.test(context) ||
    !isDateOnlyPaginationCursorPart(decisionDate) ||
    !isUuidPaginationCursorPart(decisionId)
  ) {
    return null;
  }
  return { context, decisionDate, decisionId };
};

type CitingDecisionRowsOptions = {
  tx: CaseLawPublicReadTransaction;
  conditions: SQL[];
  cursor: CitingDecisionsCursor | null;
  sort: ListCitingDecisionsQuery["sort"];
  limit: number;
  courtRegistry: CourtRegistry;
};

const readCitingDecisionRows = async ({
  tx,
  conditions,
  cursor,
  sort,
  limit,
  courtRegistry,
}: CitingDecisionRowsOptions) => {
  const mentions = tx
    .select({
      ...PROVISION_VERSION_COLUMNS,
      versionValidFrom: caseLawProvisionCitations.versionValidFrom,
      decisionId: caseLawProvisionCitations.decisionId,
      caseNumber: caseLawDecisions.caseNumber,
      // The decision's own address, so a reader can follow the citation
      // without a second read to resolve one.
      slug: caseLawDecisions.slug,
      court: caseLawDecisions.court,
      courtId: caseLawDecisions.courtId,
      ecli: caseLawDecisions.ecli,
      sourceUrl: caseLawDecisions.sourceUrl,
      country: caseLawDecisions.country,
      language: caseLawDecisions.language,
      languageGroupKey: caseLawDecisions.languageGroupKey,
      decisionDate: caseLawDecisions.decisionDate,
      citationAuthority: caseLawDecisions.citationAuthority,
      // Keep the public citation relationship when its source decision is
      // tombstoned, but do not return a verbatim excerpt from removed text.
      sentenceText: sql<string | null>`CASE
          WHEN ${caseLawDecisions.redactedAt} IS NULL
          THEN ${caseLawProvisionCitations.sentenceText}
          ELSE NULL
        END`.as("sentence_text"),
      printText: caseLawProvisionCitations.printText,
      spanStart: caseLawProvisionCitations.spanStart,
      spanEnd: caseLawProvisionCitations.spanEnd,
      anchor: caseLawProvisionCitations.anchor,
      decisionDateCursor: decisionDateCursorSql.as("decision_date_cursor"),
      mentionCount:
        sql<number>`count(*) OVER (PARTITION BY ${caseLawProvisionCitations.decisionId})::integer`.as(
          "mention_count",
        ),
      mentionRank: sql<number>`row_number() OVER (
          PARTITION BY ${caseLawProvisionCitations.decisionId}
          ORDER BY ${caseLawProvisionCitations.spanStart}, ${caseLawProvisionCitations.anchor}
        )`.as("mention_rank"),
    })
    .from(caseLawProvisionCitations)
    .innerJoin(
      caseLawDecisions,
      eq(caseLawDecisions.id, caseLawProvisionCitations.decisionId),
    )
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(and(...conditions))
    .as("citing_decision_mentions");

  let continuation: SQL | undefined;
  if (cursor !== null) {
    continuation = sql`(${mentions.decisionDateCursor}, ${mentions.decisionId}) < (${cursor.decisionDate}::text, ${cursor.decisionId}::uuid)`;
  }
  const citing = await tx
    .select({
      appliedVersionBasis: mentions.appliedVersionBasis,
      appliedVersionDate: mentions.appliedVersionDate,
      appliedVersionDateRelation: mentions.appliedVersionDateRelation,
      appliedVersionAmendmentWorkIdentifier:
        mentions.appliedVersionAmendmentWorkIdentifier,
      appliedVersionExpressionDate: mentions.appliedVersionExpressionDate,
      appliedVersionExpressionEli: mentions.appliedVersionExpressionEli,
      versionEvidenceStart: mentions.versionEvidenceStart,
      versionEvidenceEnd: mentions.versionEvidenceEnd,
      versionEvidenceKind: mentions.versionEvidenceKind,
      versionValidFrom: mentions.versionValidFrom,
      decisionId: mentions.decisionId,
      caseNumber: mentions.caseNumber,
      slug: mentions.slug,
      court: mentions.court,
      courtId: mentions.courtId,
      ecli: mentions.ecli,
      sourceUrl: mentions.sourceUrl,
      country: mentions.country,
      language: mentions.language,
      languageGroupKey: mentions.languageGroupKey,
      decisionDate: mentions.decisionDate,
      citationAuthority: mentions.citationAuthority,
      sentenceText: mentions.sentenceText,
      printText: mentions.printText,
      mentionCount: mentions.mentionCount,
      spanStart: mentions.spanStart,
      spanEnd: mentions.spanEnd,
      anchor: mentions.anchor,
      decisionDateCursor: mentions.decisionDateCursor,
    })
    .from(mentions)
    .where(and(eq(mentions.mentionRank, 1), continuation))
    .orderBy(
      ...(sort === "authority"
        ? [sql`coalesce(${mentions.citationAuthority}, 0) DESC`]
        : []),
      ...(sort === "citations" ? [desc(mentions.mentionCount)] : []),
      desc(mentions.decisionDateCursor),
      desc(mentions.decisionId),
      desc(mentions.spanStart),
      desc(mentions.anchor),
    )
    .limit(limit + 1);
  // The versions decide whether a citing decision's route names its
  // language; one read for the page.
  const alternates = await readPublicDecisionLanguageAlternatesInTx(
    tx,
    citing.map((row) => row.languageGroupKey),
  );
  return citing.map(
    ({ languageGroupKey, courtId, ecli, printText, ...row }) => ({
      ...row,
      ...courtPresentation(courtRegistry, {
        country: row.country,
        court: row.court,
        courtId,
        ecli,
      }),
      snippetCitation: snippetCitation(row.sentenceText, printText),
      languageAlternates: alternates.alternatesFor(languageGroupKey),
    }),
  );
};

type CitingDecisionsReadOptions = {
  caseLawDb: CaseLawPublicReadDb;
  courtRegistry: CourtRegistry;
};

export const listCitingDecisionsHandler = async (
  query: ListCitingDecisionsQuery,
  { caseLawDb, courtRegistry }: CitingDecisionsReadOptions,
) => {
  const countryRead = readPublicLawCountry(query.jurisdiction, {
    admitted: PUBLIC_CASE_LAW_COUNTRIES,
    parameter: "jurisdiction",
  });
  if (countryRead.kind === "unavailable") {
    return countryRead.answer;
  }
  if (countryRead.kind === "unreadable") {
    return status(400, { message: countryRead.message });
  }
  const jurisdiction = publicCaseLawCountry(countryRead.country);
  if (jurisdiction === null) {
    return status(404, { message: "Not Found" });
  }
  const work = workCondition(query);

  if (work === null) {
    return status(400, { message: "Name exactly one of work or eli" });
  }

  const byCitations = query.sort === "citations";
  const limit = byCitations
    ? PROVISION_CITING_SNAPSHOT_LIMIT
    : normalizeTenantPageLimit(
        Math.min(
          query.limit ?? LIMITS.caseLawSearchPageSizeDefault,
          LIMITS.caseLawSearchPageSizeMax,
        ),
      );
  const byAuthority = query.sort === "authority";
  if (byAuthority && query.cursor !== undefined) {
    return status(400, { message: "Authority order has no cursor" });
  }
  if (byCitations && query.cursor !== undefined) {
    return status(400, { message: "Citations order has no cursor" });
  }
  const context = sha256Hex(
    JSON.stringify([
      jurisdiction,
      query.work ?? null,
      query.eli ?? null,
      query.anchor ?? null,
      query.court ?? null,
      query.year ?? null,
      query.sort ?? "newest",
      query.excerpt ?? null,
    ]),
  );
  const cursor = query.cursor
    ? decodeCitingDecisionsCursor(query.cursor)
    : null;
  if (query.cursor && (cursor === null || cursor.context !== context)) {
    return status(400, { message: "Invalid cursor" });
  }
  const conditions: SQL[] = [
    eq(caseLawProvisionCitations.jurisdiction, jurisdiction),
    eq(caseLawDecisions.country, jurisdiction),
    work,
    redistributableCaseLawSource,
    publishedCaseLawDecision,
  ];

  if (query.anchor !== undefined) {
    conditions.push(eq(caseLawProvisionCitations.anchor, query.anchor));
  }
  if (query.excerpt === "required") {
    conditions.push(isNull(caseLawDecisions.redactedAt));
  }

  if (query.court !== undefined) {
    conditions.push(eq(caseLawDecisions.court, query.court));
  }
  if (query.year !== undefined) {
    const from = `${String(query.year).padStart(4, "0")}-01-01`;
    const until = `${String(query.year + 1).padStart(4, "0")}-01-01`;
    conditions.push(
      gte(caseLawProvisionCitations.decisionDate, from),
      lt(caseLawProvisionCitations.decisionDate, until),
    );
  }

  const rows = await caseLawDb(
    async (tx) =>
      await readCitingDecisionRows({
        tx,
        conditions,
        cursor,
        sort: query.sort,
        limit,
        courtRegistry,
      }),
  );
  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) =>
      encodePaginationCursor([
        context,
        item.decisionDateCursor,
        item.decisionId,
      ]),
  });
  return {
    ...page,
    nextCursor: byAuthority || byCitations ? null : page.nextCursor,
    snapshot: byCitations
      ? ({
          type: rows.length > limit ? "capped" : "complete",
          limit: PROVISION_CITING_SNAPSHOT_LIMIT,
        } as const)
      : null,
    items: page.items.map(
      ({ anchor: _anchor, decisionDateCursor: _decisionDateCursor, ...item }) =>
        projectProvisionVersion(item),
    ),
  };
};
