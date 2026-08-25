import { and, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import {
  caseLawDecisions,
  caseLawProvisionCitations,
  caseLawSources,
} from "@/api/db/schema";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";

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
  jurisdiction: t.String({ minLength: 2, maxLength: 3 }),
  work: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
  eli: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
  anchor: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
  limit: t.Optional(tPaginationLimit(LIMITS.caseLawSearchPageSizeMax)),
  cursor: t.Optional(tPaginationCursor()),
  /**
   * `newest` (default) pages by application date. `authority` returns one
   * page of the most authoritative citing decisions and no cursor: the
   * authority signal is refreshed in place, so it cannot key a walk.
   */
  sort: t.Optional(t.Union([t.Literal("newest"), t.Literal("authority")])),
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

/**
 * Newest application first. The order is the keyset, so every key must be
 * immutable for the life of a cursor and answerable from the citation
 * table's own index: the date is the copy written on the row, not the
 * joined decision's (authority, refreshed in place, stays out of it and is
 * returned for display only). Rendered as ISO text explicitly, so the
 * cursor does not depend on the server's DateStyle.
 */
const decisionDateKeySql = sql`coalesce(${caseLawProvisionCitations.decisionDate}, ${DECISION_DATE_FLOOR}::date)`;
const decisionDateCursorSql = sql<string>`to_char(${decisionDateKeySql}, 'YYYY-MM-DD')`;

type CitingDecisionsCursor = {
  decisionDate: string;
  decisionId: string;
  spanStart: number;
  anchor: string;
};

const decodeCitingDecisionsCursor = (
  cursor: string,
): CitingDecisionsCursor | null => {
  const parts = decodePaginationCursor(cursor);
  if (parts?.length !== 4) {
    return null;
  }

  const [decisionDate, decisionId, spanStart, anchor] = parts;
  if (
    !isDateOnlyPaginationCursorPart(decisionDate) ||
    !isUuidPaginationCursorPart(decisionId) ||
    typeof spanStart !== "number" ||
    !Number.isInteger(spanStart) ||
    typeof anchor !== "string"
  ) {
    return null;
  }

  return { decisionDate, decisionId, spanStart, anchor };
};

export const listCitingDecisionsHandler = async (
  query: ListCitingDecisionsQuery,
  caseLawDb: CaseLawPublicReadDb,
) => {
  const work = workCondition(query);

  if (work === null) {
    return status(400, { message: "Name exactly one of work or eli" });
  }

  const limit = query.limit ?? LIMITS.caseLawSearchPageSizeDefault;
  const byAuthority = query.sort === "authority";
  if (byAuthority && query.cursor !== undefined) {
    return status(400, { message: "Authority order has no cursor" });
  }
  const conditions: SQL[] = [
    eq(caseLawProvisionCitations.jurisdiction, query.jurisdiction),
    work,
    redistributableCaseLawSource,
  ];

  if (query.anchor !== undefined) {
    conditions.push(eq(caseLawProvisionCitations.anchor, query.anchor));
  }

  if (query.cursor) {
    const cursor = decodeCitingDecisionsCursor(query.cursor);
    if (cursor === null) {
      return status(400, { message: "Invalid cursor" });
    }

    conditions.push(
      sql`(
        ${decisionDateKeySql},
        ${caseLawProvisionCitations.decisionId},
        ${caseLawProvisionCitations.spanStart},
        ${caseLawProvisionCitations.anchor}
      ) < (
        ${cursor.decisionDate}::date,
        ${cursor.decisionId}::uuid,
        ${cursor.spanStart}::integer,
        ${cursor.anchor}::text
      )`,
    );
  }

  const rows = await caseLawDb(async (tx) => {
    const mentions = tx
      .select({
        decisionId: caseLawProvisionCitations.decisionId,
        caseNumber: caseLawDecisions.caseNumber,
        // The decision's own address, so a reader can follow the citation
        // without a second read to resolve one.
        slug: caseLawDecisions.slug,
        court: caseLawDecisions.court,
        country: caseLawDecisions.country,
        decisionDate: caseLawDecisions.decisionDate,
        citationAuthority: caseLawDecisions.citationAuthority,
        sentenceText: caseLawProvisionCitations.sentenceText,
        spanStart: caseLawProvisionCitations.spanStart,
        spanEnd: caseLawProvisionCitations.spanEnd,
        anchor: caseLawProvisionCitations.anchor,
        decisionDateCursor: decisionDateCursorSql.as("decision_date_cursor"),
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
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(and(...conditions))
      .as("citing_decision_mentions");

    return await tx
      .select({
        decisionId: mentions.decisionId,
        caseNumber: mentions.caseNumber,
        slug: mentions.slug,
        court: mentions.court,
        country: mentions.country,
        decisionDate: mentions.decisionDate,
        citationAuthority: mentions.citationAuthority,
        sentenceText: mentions.sentenceText,
        spanStart: mentions.spanStart,
        spanEnd: mentions.spanEnd,
        anchor: mentions.anchor,
        decisionDateCursor: mentions.decisionDateCursor,
      })
      .from(mentions)
      .where(byAuthority ? eq(mentions.mentionRank, 1) : undefined)
      .orderBy(
        ...(byAuthority
          ? [sql`coalesce(${mentions.citationAuthority}, 0) DESC`]
          : []),
        desc(mentions.decisionDateCursor),
        desc(mentions.decisionId),
        desc(mentions.spanStart),
        desc(mentions.anchor),
      )
      .limit(limit + 1);
  });

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) =>
      encodePaginationCursor([
        item.decisionDateCursor,
        item.decisionId,
        item.spanStart,
        item.anchor,
      ]),
  });

  return {
    ...page,
    nextCursor: byAuthority ? null : page.nextCursor,
    items: page.items.map(
      ({ anchor: _anchor, decisionDateCursor: _decisionDateCursor, ...item }) =>
        item,
    ),
  };
};
