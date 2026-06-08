import { inArray, sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { legislationDocuments } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
// eslint-disable-next-line no-restricted-imports -- search boundary: brands document ids returned by the corpus index before re-hydrating from Postgres
import { toSafeId } from "@/api/lib/branded-types";
import { isUuid } from "@/api/lib/custom-schema";
import { corpusGeneration } from "@/api/lib/legal-search/corpus-family";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import {
  corpusIndexId,
  corpusIndexPattern,
} from "@/api/lib/legal-search/index-naming";
import {
  blendCitationAuthority,
  type ScoredCandidate,
} from "@/api/lib/legal-search/rerank";
import { LIMITS } from "@/api/lib/limits";
import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";
import {
  escapeAndHighlight,
  TS_HEADLINE_CONFIG,
} from "@/api/lib/search/highlight";

/**
 * Legislation search. Same two-engine shape as case law (pg-fts default,
 * corpus index when LEGAL_SEARCH_PROVIDER=corpus-index) over the `legislation`
 * family, returning legislation-shaped hits (eli/status/effectiveDate).
 */

export const searchLegislationBodySchema = t.Object({
  query: t.String({ minLength: 1, maxLength: LIMITS.searchQueryMaxLength }),
  limit: t.Optional(
    t.Number({ minimum: 1, maximum: LIMITS.caseLawSearchPageSizeMax }),
  ),
  cursor: t.Optional(t.String()),
  jurisdiction: t.Optional(t.String({ maxLength: 3 })),
  documentType: t.Optional(t.String({ maxLength: 128 })),
  status: t.Optional(t.String({ maxLength: 32 })),
  source: t.Optional(t.String({ maxLength: 36 })),
  language: t.Optional(t.String({ maxLength: 8 })),
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
});

type SearchLegislationBody = Static<typeof searchLegislationBodySchema>;

type LegislationHit = {
  documentId: string;
  eli: string;
  title: string;
  country: string;
  language: string;
  documentType: string | null;
  status: string;
  effectiveDate: string | null;
  sourceUrl: string | null;
  headline: string | null;
  score: number;
};

type RawRow = Record<string, unknown>;

const toNullableString = (x: unknown): string | null => {
  if (x === null || x === undefined) {
    return null;
  }

  if (typeof x === "string") {
    return x;
  }

  if (typeof x === "number" || typeof x === "boolean") {
    return x.toString();
  }

  if (x instanceof Date) {
    return x.toISOString();
  }

  return JSON.stringify(x);
};

const headlineRegconfig = sql`'public.stella_unaccent'::regconfig`;

const pgSearch = async (
  body: SearchLegislationBody,
  parsedCursor: { score: number; id: string } | null,
  scopedDb: ScopedDb,
): Promise<{ hits: LegislationHit[]; nextCursor: string | null }> => {
  const limit = body.limit ?? LIMITS.caseLawSearchPageSizeDefault;
  const tsQuery = sql`plainto_tsquery('simple', unaccent(${body.query}))`;

  const filters = sql`
    ${body.jurisdiction ? sql`AND d.country = ${body.jurisdiction}` : sql``}
    ${body.documentType ? sql`AND d.document_type = ${body.documentType}` : sql``}
    ${body.status ? sql`AND d.status = ${body.status}` : sql``}
    ${body.source ? sql`AND d.source_id = ${body.source}` : sql``}
    ${body.language ? sql`AND d.language = ${body.language}` : sql``}
    ${body.dateFrom ? sql`AND d.effective_date >= ${body.dateFrom}` : sql``}
    ${body.dateTo ? sql`AND d.effective_date <= ${body.dateTo}` : sql``}
  `;

  const scoreExpr = sql`(ts_rank(sd.tsv, ${tsQuery})::float8 + 0.3 * d.citation_authority)`;
  const cursorFilter = parsedCursor
    ? sql`AND (${scoreExpr}, sd.document_id) < (${parsedCursor.score}::float8, ${parsedCursor.id})`
    : sql``;

  const rows = await scopedDb((tx) =>
    tx.execute(sql`
    SELECT
      sd.document_id,
      d.eli,
      d.title,
      d.country,
      d.language,
      d.document_type,
      d.status,
      d.effective_date,
      d.source_url,
      ts_headline(
        ${headlineRegconfig},
        coalesce(nullif(d.fulltext, ''), sd.searchable_text),
        ${tsQuery},
        ${TS_HEADLINE_CONFIG}
      ) AS headline,
      ${scoreExpr} AS score
    FROM legislation_search_documents sd
    JOIN legislation_documents d ON d.id = sd.document_id
    WHERE sd.tsv @@ ${tsQuery}
      ${filters}
      ${cursorFilter}
    ORDER BY score DESC, sd.document_id DESC
    LIMIT ${limit + 1}
  `),
  );

  const result: RawRow[] = rows;
  const hasMore = result.length > limit;
  const pageRows = hasMore ? result.slice(0, limit) : result;
  const lastRow = pageRows.at(-1);
  const nextCursor =
    hasMore && lastRow
      ? encodeCursor(Number(lastRow["score"]), String(lastRow["document_id"]))
      : null;

  const hits = pageRows.map((row) => mapRowHit(row));
  return { hits, nextCursor };
};

const mapRowHit = (row: RawRow): LegislationHit => ({
  documentId: String(row["document_id"]),
  eli: String(row["eli"]),
  title: String(row["title"]),
  country: String(row["country"]),
  language: String(row["language"]),
  documentType: toNullableString(row["document_type"]),
  status: String(row["status"]),
  effectiveDate: toNullableString(row["effective_date"]),
  sourceUrl: toNullableString(row["source_url"]),
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- row.headline from DB (any)
  headline: row["headline"]
    ? escapeAndHighlight(JSON.stringify(row["headline"]))
    : null,
  score: Number(row["score"]) || 0,
});

const buildCorpusIndexQuery = (body: SearchLegislationBody): string => {
  const q = (v: string) => `"${v.replaceAll('"', '\\"')}"`;
  const clauses = [`(${body.query})`];
  if (body.documentType) {
    clauses.push(`document_type:${q(body.documentType)}`);
  }
  if (body.status) {
    clauses.push(`status:${q(body.status)}`);
  }
  if (body.source) {
    clauses.push(`source:${q(body.source)}`);
  }
  if (body.language) {
    clauses.push(`language:${q(body.language)}`);
  }
  if (body.dateFrom || body.dateTo) {
    clauses.push(
      `effective_date:[${body.dateFrom ?? "*"} TO ${body.dateTo ?? "*"}]`,
    );
  }
  return clauses.join(" AND ");
};

const corpusIndexSearch = async (
  body: SearchLegislationBody,
  parsedCursor: { score: number; id: string } | null,
  scopedDb: ScopedDb,
): Promise<{ hits: LegislationHit[]; nextCursor: string | null }> => {
  const limit = body.limit ?? LIMITS.caseLawSearchPageSizeDefault;
  const generation = corpusGeneration("legislation");
  const indexId = body.jurisdiction
    ? corpusIndexId(generation, body.jurisdiction)
    : corpusIndexPattern(generation);

  const result = await getCorpusIndexClient().search({
    indexId,
    query: buildCorpusIndexQuery(body),
    maxHits: LIMITS.corpusIndexSearchCandidateLimit,
    snippetFields: ["text"],
  });
  if (result.isErr()) {
    throw result.error;
  }

  const candidates: ScoredCandidate[] = [];
  const snippetById = new Map<string, string>();
  for (const [index, hit] of result.value.hits.entries()) {
    const id = hit["document_id"];
    if (typeof id !== "string") {
      continue;
    }
    candidates.push({ id, score: result.value.hits.length - index });
    const snippet = result.value.snippets[index]?.["text"];
    const raw = Array.isArray(snippet) ? snippet.join(" … ") : snippet;
    if (typeof raw === "string" && raw.length > 0) {
      snippetById.set(
        id,
        raw.replaceAll("<b>", "<mark>").replaceAll("</b>", "</mark>"),
      );
    }
  }

  const ids = candidates.map((c) => toSafeId<"legislationDocument">(c.id));
  const rows =
    ids.length === 0
      ? []
      : await scopedDb((tx) =>
          tx
            .select({
              id: legislationDocuments.id,
              eli: legislationDocuments.eli,
              title: legislationDocuments.title,
              country: legislationDocuments.country,
              language: legislationDocuments.language,
              documentType: legislationDocuments.documentType,
              statusValue: legislationDocuments.status,
              effectiveDate: legislationDocuments.effectiveDate,
              sourceUrl: legislationDocuments.sourceUrl,
              citationAuthority: legislationDocuments.citationAuthority,
            })
            .from(legislationDocuments)
            .where(inArray(legislationDocuments.id, ids)),
        );

  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const authorityById = new Map(
    rows.map((row) => [String(row.id), row.citationAuthority]),
  );

  const ranked = blendCitationAuthority({
    candidates: candidates.filter((c) => byId.has(c.id)),
    authorityById,
  });

  const windowed = parsedCursor
    ? ranked.filter(
        (hit) =>
          hit.score < parsedCursor.score ||
          (hit.score === parsedCursor.score && hit.id < parsedCursor.id),
      )
    : ranked;
  const hasMore = windowed.length > limit;
  const pageRanked = hasMore ? windowed.slice(0, limit) : windowed;
  const last = pageRanked.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.score, last.id) : null;

  const hits = pageRanked.flatMap((hit): LegislationHit[] => {
    const row = byId.get(hit.id);
    if (!row) {
      return [];
    }
    return [
      {
        documentId: row.id,
        eli: row.eli,
        title: row.title,
        country: row.country,
        language: row.language,
        documentType: toNullableString(row.documentType),
        status: row.statusValue,
        effectiveDate: toNullableString(row.effectiveDate),
        sourceUrl: toNullableString(row.sourceUrl),
        headline: snippetById.get(hit.id) ?? null,
        score: hit.score,
      },
    ];
  });

  return { hits, nextCursor };
};

export const searchLegislationHandler = async (
  body: SearchLegislationBody,
  scopedDb: ScopedDb,
) => {
  // source_id and the cursor id reach Postgres as UUID comparisons in the
  // pg-fts path; reject malformed values at the boundary so a bad filter
  // is a 400, not a 500 from an invalid-uuid cast.
  if (body.source !== undefined && !isUuid(body.source)) {
    return status(400, { message: "Invalid source" });
  }

  const parsedCursor = body.cursor ? decodeCursor(body.cursor) : null;
  if (
    body.cursor !== undefined &&
    (parsedCursor === null || !isUuid(parsedCursor.id))
  ) {
    return status(400, { message: "Invalid cursor" });
  }

  const { hits, nextCursor } =
    envBase.LEGAL_SEARCH_PROVIDER === "corpus-index"
      ? await corpusIndexSearch(body, parsedCursor, scopedDb)
      : await pgSearch(body, parsedCursor, scopedDb);

  return { hits, nextCursor, totalCount: null };
};
