import { and, desc, eq, sql } from "drizzle-orm";
import { t, type Static } from "elysia";

import { db } from "@/api/db";
import { caseLawDecisions } from "@/api/db/schema";
import { LIMITS } from "@/api/lib/limits";

export const searchDecisionsBodySchema = t.Object({
  query: t.String({ minLength: 1, maxLength: 500 }),
  limit: t.Optional(
    t.Number({
      minimum: 1,
      maximum: LIMITS.caseLawSearchPageSizeMax,
    }),
  ),
  offset: t.Optional(t.Number({ minimum: 0, maximum: 500 })),
  court: t.Optional(t.String({ maxLength: 512 })),
  country: t.Optional(t.String({ maxLength: 3 })),
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
  decisionType: t.Optional(t.String({ maxLength: 128 })),
  sourceId: t.Optional(t.String({ maxLength: 21 })),
});

type SearchDecisionsBody = Static<typeof searchDecisionsBodySchema>;

export const searchDecisionsHandler = async (body: SearchDecisionsBody) => {
  const limit = body.limit ?? LIMITS.caseLawSearchPageSizeDefault;
  const offset = body.offset ?? 0;
  const tsQuery = sql`plainto_tsquery('simple', ${body.query})`;

  const conditions = [sql`${caseLawDecisions.searchVector} @@ ${tsQuery}`];

  if (body.court) {
    conditions.push(eq(caseLawDecisions.court, body.court));
  }

  if (body.country) {
    conditions.push(eq(caseLawDecisions.country, body.country));
  }

  if (body.dateFrom) {
    conditions.push(sql`${caseLawDecisions.decisionDate} >= ${body.dateFrom}`);
  }

  if (body.dateTo) {
    conditions.push(sql`${caseLawDecisions.decisionDate} <= ${body.dateTo}`);
  }

  if (body.decisionType) {
    conditions.push(eq(caseLawDecisions.decisionType, body.decisionType));
  }

  if (body.sourceId) {
    conditions.push(eq(caseLawDecisions.sourceId, body.sourceId));
  }

  const rank = sql`ts_rank(${caseLawDecisions.searchVector}, ${tsQuery})`;

  const decisions = await db
    .select({
      id: caseLawDecisions.id,
      caseNumber: caseLawDecisions.caseNumber,
      ecli: caseLawDecisions.ecli,
      court: caseLawDecisions.court,
      country: caseLawDecisions.country,
      language: caseLawDecisions.language,
      decisionDate: caseLawDecisions.decisionDate,
      decisionType: caseLawDecisions.decisionType,
      sourceUrl: caseLawDecisions.sourceUrl,
      createdAt: caseLawDecisions.createdAt,
    })
    .from(caseLawDecisions)
    .where(and(...conditions))
    .orderBy(desc(rank))
    .offset(offset)
    .limit(limit + 1);

  const hasMore = decisions.length > limit;
  const items = hasMore ? decisions.slice(0, limit) : decisions;
  const nextOffset = hasMore ? offset + limit : null;

  return { decisions: items, nextOffset };
};
