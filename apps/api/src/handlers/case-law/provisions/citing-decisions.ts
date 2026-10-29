import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import * as v from "valibot";

import {
  PUBLIC_CASE_LAW_COUNTRIES,
  publicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";
import { numberFromString } from "@stll/api-contract/http-input";
import {
  PROVISION_CITING_DECISION_SORTS,
  PROVISION_CITING_FILTER_LIMITS,
  PROVISION_CITING_SNAPSHOT_LIMIT,
} from "@stll/api-contract/provision-citing-decisions";
import { sha256Hex } from "@stll/sha256/bun";

import {
  caseLawProvisionCitations,
  caseLawSources,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import { status } from "@/api/http/status";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { courtPresentation } from "@/api/lib/case-law/court-presentation";
import type { CourtRegistry } from "@/api/lib/case-law/court-presentation";
import { readPublicDecisionLanguageAlternatesInTx } from "@/api/lib/case-law/language-alternates";
import { provisionAnchorSubtreeSql } from "@/api/lib/case-law/provision-anchor-lineage";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import {
  paginationCursorSchema,
  paginationLimitSchema,
} from "@/api/lib/custom-schema";
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
  projectProvisionVersion,
  PROVISION_VERSION_COLUMNS,
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
export const listCitingDecisionsQuerySchema = v.object({
  jurisdiction: tPublicLawCountry,
  work: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
  eli: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
  anchor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
  limit: v.optional(
    numberFromString(
      paginationLimitSchema(
        Math.max(
          LIMITS.caseLawSearchPageSizeMax,
          PROVISION_CITING_SNAPSHOT_LIMIT,
        ),
      ),
    ),
  ),
  cursor: v.optional(
    v.pipe(
      paginationCursorSchema(),
      v.check(
        (cursor) => decodeCitingDecisionsCursor(cursor) !== null,
        "Invalid cursor",
      ),
    ),
  ),
  sort: v.optional(
    v.picklist([...PROVISION_CITING_DECISION_SORTS, "authority"]),
  ),
  court: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(PROVISION_CITING_FILTER_LIMITS.courtChars),
    ),
  ),
  year: v.optional(
    numberFromString(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(PROVISION_CITING_FILTER_LIMITS.yearMin),
        v.maxValue(PROVISION_CITING_FILTER_LIMITS.yearMax),
      ),
    ),
  ),
  excerpt: v.optional(v.literal("required")),
});

type ListCitingDecisionsQuery = v.InferOutput<
  typeof listCitingDecisionsQuerySchema
>;

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

/**
 * A null date sorts last under the shared descending order. The floor is
 * spelled inline, never bound: the page groups and orders by this key, which
 * PostgreSQL matches by expression, and two parameters are never equal.
 */
const decisionDateKeySql = sql`coalesce(${caseLawProvisionCitations.decisionDate}, '0001-01-01'::date)`;
const decisionDateCursorSql = sql<string>`to_char(${decisionDateKeySql}, 'YYYY-MM-DD')`;

type CitingDecisionsCursor = {
  context: string;
  decisionDate: string;
  decisionId: string;
};

export const decodeCitingDecisionsCursor = (
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

export const encodeCitingDecisionsCursor = (
  cursor: CitingDecisionsCursor,
): string =>
  encodePaginationCursor([
    cursor.context,
    cursor.decisionDate,
    cursor.decisionId,
  ]);

type CitingDecisionsPageOptions = {
  tx: CaseLawPublicReadTransaction;
  conditions: CitingDecisionConditions;
  cursor: CitingDecisionsCursor | null;
  sort: ListCitingDecisionsQuery["sort"];
  limit: number;
};

type CitingPageKeys = {
  citationAuthority: SQLWrapper;
  mentionCount: SQLWrapper;
  decisionDateKey: SQLWrapper;
  decisionId: SQLWrapper;
};

/** The page order: the requested rank, then newest first, then the id. */
const citingPageOrder = (
  sort: ListCitingDecisionsQuery["sort"],
  keys: CitingPageKeys,
): SQL[] => [
  ...(sort === "authority"
    ? [sql`coalesce(${keys.citationAuthority}, 0) DESC`]
    : []),
  ...(sort === "citations" ? [sql`${keys.mentionCount} DESC`] : []),
  sql`${keys.decisionDateKey} DESC`,
  sql`${keys.decisionId} DESC`,
];

/**
 * One page of citing decisions, each with its earliest mention and the count
 * of all its mentions the conditions admit.
 *
 * Three steps, so a page never waits on the whole citing set:
 *
 * 1. The link rows alone, one group per decision: its date key and its
 *    mention count. Every column this step reads is a key of the anchor
 *    indexes, so a provision's subtree is one index-only range and no
 *    decision row is read. The groups leave this step in page order.
 * 2. The groups joined to their decisions one at a time, in that order,
 *    until the page is full. Only the authority order ranks by a decision
 *    column, so only it reads every candidate's decision first.
 * 3. The earliest mention of each decision on the page, one lookup per row
 *    through the decision's own span index.
 *
 * `query-plans/registry.ts` holds the access paths, and
 * `citing-decisions-plan.db.test.ts` holds the decision reads to the page.
 */
export const citingDecisionsPageQuery = ({
  tx,
  conditions,
  cursor,
  sort,
  limit,
}: CitingDecisionsPageOptions) => {
  let continuation: SQL | undefined;
  if (cursor !== null) {
    continuation = sql`(${decisionDateCursorSql}, ${caseLawProvisionCitations.decisionId}) < (${cursor.decisionDate}::text, ${cursor.decisionId}::uuid)`;
  }
  // The groups leave in page order, which is what lets the join below stop
  // at the limit. The authority order ranks by a decision column, so for it
  // this order is only the tie-break.
  const citing = tx
    .select({
      decisionId: caseLawProvisionCitations.decisionId,
      decisionDateKey: sql<string>`${decisionDateKeySql}`.as(
        "decision_date_key",
      ),
      mentionCount: sql<number>`count(*)::integer`.as("mention_count"),
    })
    .from(caseLawProvisionCitations)
    .where(and(...conditions.links, continuation))
    // sql-perf-allow: index case_law_provision_citations_work_subtree_page_idx (or its ELI twin), bounded by one provision's subtree read from the index alone
    .groupBy(decisionDateKeySql, caseLawProvisionCitations.decisionId)
    // SAFETY: the groups are a subquery the page below limits; a limit here
    // would cut candidates the decision filters have not yet judged.
    // oxlint-disable-next-line require-query-limit/require-query-limit -- the enclosing page query applies the limit; see SAFETY above
    .orderBy(
      ...(sort === "citations" ? [sql`count(*)::integer DESC`] : []),
      sql`${decisionDateKeySql} DESC`,
      sql`${caseLawProvisionCitations.decisionId} DESC`,
    )
    .as("citing_decisions");

  const page = tx
    .select({
      decisionId: citing.decisionId,
      decisionDateKey: citing.decisionDateKey,
      mentionCount: citing.mentionCount,
      caseNumber: publishedCaseLawDecisions.caseNumber,
      // The decision's own address, so a reader can follow the citation
      // without a second read to resolve one.
      slug: publishedCaseLawDecisions.slug,
      court: publishedCaseLawDecisions.court,
      courtId: publishedCaseLawDecisions.courtId,
      ecli: publishedCaseLawDecisions.ecli,
      sourceUrl: publishedCaseLawDecisions.sourceUrl,
      country: publishedCaseLawDecisions.country,
      language: publishedCaseLawDecisions.language,
      languageGroupKey: publishedCaseLawDecisions.languageGroupKey,
      decisionDate: publishedCaseLawDecisions.decisionDate,
      citationAuthority: publishedCaseLawDecisions.citationAuthority,
    })
    .from(citing)
    .innerJoin(
      publishedCaseLawDecisions,
      eq(publishedCaseLawDecisions.id, citing.decisionId),
    )
    .innerJoin(
      caseLawSources,
      eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
    )
    .where(and(...conditions.decisions))
    .orderBy(
      ...citingPageOrder(sort, {
        citationAuthority: publishedCaseLawDecisions.citationAuthority,
        mentionCount: citing.mentionCount,
        decisionDateKey: citing.decisionDateKey,
        decisionId: citing.decisionId,
      }),
    )
    .limit(limit + 1)
    .as("citing_decision_page");

  const firstMention = tx
    .select({
      ...PROVISION_VERSION_COLUMNS,
      versionValidFrom: caseLawProvisionCitations.versionValidFrom,
      sentenceText: sql<
        string | null
      >`${caseLawProvisionCitations.sentenceText}`.as("sentence_text"),
      printText: caseLawProvisionCitations.printText,
      spanStart: caseLawProvisionCitations.spanStart,
      spanEnd: caseLawProvisionCitations.spanEnd,
    })
    .from(caseLawProvisionCitations)
    .where(
      and(
        eq(caseLawProvisionCitations.decisionId, page.decisionId),
        ...conditions.links,
      ),
    )
    .orderBy(
      asc(caseLawProvisionCitations.spanStart),
      asc(caseLawProvisionCitations.anchor),
    )
    .limit(1)
    .as("citing_decision_first_mention");

  return (
    tx
      .select({
        appliedVersionBasis: firstMention.appliedVersionBasis,
        appliedVersionDate: firstMention.appliedVersionDate,
        appliedVersionDateRelation: firstMention.appliedVersionDateRelation,
        appliedVersionAmendmentWorkIdentifier:
          firstMention.appliedVersionAmendmentWorkIdentifier,
        appliedVersionExpressionDate: firstMention.appliedVersionExpressionDate,
        appliedVersionExpressionEli: firstMention.appliedVersionExpressionEli,
        versionEvidenceStart: firstMention.versionEvidenceStart,
        versionEvidenceEnd: firstMention.versionEvidenceEnd,
        versionEvidenceKind: firstMention.versionEvidenceKind,
        versionValidFrom: firstMention.versionValidFrom,
        decisionId: page.decisionId,
        caseNumber: page.caseNumber,
        slug: page.slug,
        court: page.court,
        courtId: page.courtId,
        ecli: page.ecli,
        sourceUrl: page.sourceUrl,
        country: page.country,
        language: page.language,
        languageGroupKey: page.languageGroupKey,
        decisionDate: page.decisionDate,
        citationAuthority: page.citationAuthority,
        sentenceText: firstMention.sentenceText,
        printText: firstMention.printText,
        mentionCount: page.mentionCount,
        spanStart: firstMention.spanStart,
        spanEnd: firstMention.spanEnd,
        decisionDateCursor: sql<string>`to_char(${page.decisionDateKey}, 'YYYY-MM-DD')`,
      })
      .from(page)
      .innerJoinLateral(firstMention, sql`true`)
      // SAFETY: one row per page row, and the page holds at most limit + 1.
      // oxlint-disable-next-line require-query-limit/require-query-limit -- the page subquery applies the limit; see SAFETY above
      .orderBy(...citingPageOrder(sort, page))
  );
};

type CitingDecisionRowsOptions = CitingDecisionsPageOptions & {
  courtRegistry: CourtRegistry;
};

const readCitingDecisionRows = async ({
  courtRegistry,
  ...page
}: CitingDecisionRowsOptions) => {
  const { tx } = page;
  const citing = await citingDecisionsPageQuery(page);
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

/** Target jurisdiction and citing-country admission are one scope decision. */
export const citingJurisdictionScope = (country: string) => {
  if (country === "EU") {
    return {
      jurisdiction: "EU",
      decisionCountryCondition: inArray(
        publishedCaseLawDecisions.country,
        PUBLIC_CASE_LAW_COUNTRIES,
      ),
    };
  }
  const jurisdiction = publicCaseLawCountry(country);
  if (jurisdiction === null) {
    return null;
  }
  return {
    jurisdiction,
    decisionCountryCondition: eq(
      publishedCaseLawDecisions.country,
      jurisdiction,
    ),
  };
};

type CitingJurisdictionScope = NonNullable<
  ReturnType<typeof citingJurisdictionScope>
>;

/**
 * What a request admits, split by the table that decides it: the link rows
 * alone pick and count each decision's mentions, and the decision and its
 * source admit the decision. A page reads the second only for the decisions
 * the first already ordered.
 */
type CitingDecisionConditions = {
  links: SQL[];
  decisions: SQL[];
};

/**
 * The link rows and decisions a request admits, or null when it names
 * neither work key or both.
 */
export const citingDecisionConditions = (
  query: ListCitingDecisionsQuery,
  { jurisdiction, decisionCountryCondition }: CitingJurisdictionScope,
): CitingDecisionConditions | null => {
  const work = workCondition(query);
  if (work === null) {
    return null;
  }
  const links: SQL[] = [
    eq(caseLawProvisionCitations.jurisdiction, jurisdiction),
    work,
  ];
  const decisions: SQL[] = [
    decisionCountryCondition,
    redistributableCaseLawSource,
  ];

  // A provision is cited by every citation of a subdivision under it, so a
  // section lists the decisions citing only `odst. 1` of it, and each
  // decision's mention count covers the whole subtree.
  if (query.anchor !== undefined) {
    links.push(
      provisionAnchorSubtreeSql(caseLawProvisionCitations.anchor, {
        jurisdiction,
        anchor: query.anchor,
      }),
    );
  }
  if (query.court !== undefined) {
    decisions.push(eq(publishedCaseLawDecisions.court, query.court));
  }
  if (query.year !== undefined) {
    const from = `${String(query.year).padStart(4, "0")}-01-01`;
    const until = `${String(query.year + 1).padStart(4, "0")}-01-01`;
    links.push(
      gte(caseLawProvisionCitations.decisionDate, from),
      lt(caseLawProvisionCitations.decisionDate, until),
    );
  }
  return { links, decisions };
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
    domain: "caseLaw",
    admitted: PUBLIC_CASE_LAW_COUNTRIES,
    surface: "search",
    parameter: "jurisdiction",
    jurisdictionType: "provision",
  });
  if (countryRead.kind === "unavailable") {
    return countryRead.answer;
  }
  if (countryRead.kind === "unreadable") {
    return status(400, { message: countryRead.message });
  }
  const scope = citingJurisdictionScope(countryRead.country);
  if (scope === null) {
    return status(404, { message: "Not Found" });
  }
  const conditions = citingDecisionConditions(query, scope);
  if (conditions === null) {
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
      scope.jurisdiction,
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
      ({ decisionDateCursor: _decisionDateCursor, ...item }) =>
        projectProvisionVersion(item),
    ),
  };
};
