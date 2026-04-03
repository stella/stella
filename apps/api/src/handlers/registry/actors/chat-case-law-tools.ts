import { valibotSchema } from "@ai-sdk/valibot";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import type { ScopedDb } from "@/api/db";
import { loadCourtWeights } from "@/api/handlers/case-law/court-weights";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import { isRecord } from "@/api/lib/type-guards";

import { defineTool } from "./chat-tools";

const HEADLINE_CONFIG = "MaxWords=50, MinWords=20";

const toNullableString = (x: unknown): string | null => {
  if (x === null || x === undefined) {
    return null;
  }
  if (typeof x === "string") {
    return x;
  }
  if (typeof x === "number" || typeof x === "boolean") {
    return String(x);
  }
  return JSON.stringify(x);
};

/** Strip HTML tags from ts_headline output so the AI sees
 *  plain text without markup. */
const stripTags = (html: string): string => html.replace(/<[^>]+>/g, "");

export const createCaseLawTools = (scopedDb: ScopedDb) => ({
  searchCaseLaw: defineTool({
    name: "searchCaseLaw",
    description:
      "Search the case law library for court decisions " +
      "across all jurisdictions. Returns matching " +
      "decisions with excerpts. Use this when the user " +
      "asks about case law, court decisions, legal " +
      "precedents, or judicial rulings.",
    inputSchema: valibotSchema(
      v.strictObject({
        query: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(LIMITS.searchQueryMaxLength),
          v.description("Search query (keywords or phrases)"),
        ),
        country: v.optional(
          v.pipe(
            v.string(),
            v.minLength(2),
            v.maxLength(3),
            v.description(
              "ISO country code (alpha-3, e.g. CZE, SVK, POL, AUT)",
            ),
          ),
        ),
        court: v.optional(
          v.pipe(
            v.string(),
            v.maxLength(512),
            v.description("Court name to filter by"),
          ),
        ),
        minTier: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.maxValue(4),
            v.description(
              "Minimum court tier: 4=constitutional, " +
                "3=supreme, 2=regional, 1=district",
            ),
          ),
        ),
        dateFrom: v.optional(
          v.pipe(
            v.string(),
            v.description("Earliest decision date (YYYY-MM-DD)"),
          ),
        ),
        dateTo: v.optional(
          v.pipe(
            v.string(),
            v.description("Latest decision date (YYYY-MM-DD)"),
          ),
        ),
        sortBy: v.optional(
          v.pipe(
            v.picklist(["relevance", "date", "authority"]),
            v.description(
              "Sort order: relevance (FTS rank + authority), " +
                "date (newest first), authority (citation score)",
            ),
          ),
          "relevance",
        ),
        limit: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.maxValue(20),
            v.description("Max results to return"),
          ),
          10,
        ),
      }),
    ),
    execute: async ({
      query,
      country: rawCountry,
      court,
      minTier,
      dateFrom,
      dateTo,
      sortBy,
      limit,
    }) => {
      const country = rawCountry?.toUpperCase();
      const tsQuery = sql`plainto_tsquery('simple', ${query})`;

      const courtFilter = court
        ? sql`AND d.court ILIKE ${`%${escapeLike(court)}%`}`
        : sql``;
      const countryFilter = country ? sql`AND d.country = ${country}` : sql``;
      const dateFromFilter = dateFrom
        ? sql`AND d.decision_date >= ${dateFrom}::date`
        : sql``;
      const dateToFilter = dateTo
        ? sql`AND d.decision_date <= ${dateTo}::date`
        : sql``;

      // Tier filter: load court weights and build a regex
      // alternation so the DB can filter by court name pattern.
      let tierFilter = sql``;
      if (minTier !== undefined && minTier > 1) {
        const weightMap = await loadCourtWeights();
        const patterns: string[] = [];
        for (const entries of weightMap.values()) {
          for (const e of entries) {
            if (e.tier >= minTier) {
              patterns.push(e.pattern.source);
            }
          }
        }
        if (patterns.length > 0) {
          const regex = patterns.join("|");
          tierFilter = sql`AND d.court ~* ${regex}`;
        }
      }

      const orderBy =
        sortBy === "date"
          ? sql`d.decision_date DESC NULLS LAST, d.id DESC`
          : sortBy === "authority"
            ? sql`COALESCE(cb.boost, 1) DESC, ts_rank(sd.tsv, ${tsQuery}) DESC`
            : sql`ts_rank(sd.tsv, ${tsQuery}) * COALESCE(cb.boost, 1) DESC, d.id DESC`;

      // Raw SQL: Drizzle lacks tsvector/ts_headline support
      const result = await scopedDb((tx) =>
        tx.execute(sql`
        WITH citation_boost AS (
          SELECT
            cited_decision_id AS decision_id,
            1 + LN(1 + COUNT(*)) AS boost
          FROM case_law_citations
          WHERE cited_decision_id IS NOT NULL
          GROUP BY cited_decision_id
        )
        SELECT
          d.id,
          d.case_number,
          d.ecli,
          d.court,
          d.country,
          d.decision_date,
          d.decision_type,
          ts_headline(
            'simple',
            COALESCE(sd.title, '') || ' ' ||
              left(sd.searchable_text, 2000),
            ${tsQuery},
            ${HEADLINE_CONFIG}
          ) AS headline
        FROM case_law_search_documents sd
        JOIN case_law_decisions d
          ON d.id = sd.decision_id
        LEFT JOIN citation_boost cb
          ON cb.decision_id = d.id
        WHERE sd.tsv @@ ${tsQuery}
          ${courtFilter}
          ${countryFilter}
          ${dateFromFilter}
          ${dateToFilter}
          ${tierFilter}
        ORDER BY ${orderBy}
        LIMIT ${limit}
      `),
      );

      return {
        resultCount: result.length,
        decisions: result.map((row: Record<string, unknown>) => ({
          decisionId: String(row.id),
          caseNumber: String(row.case_number),
          ecli: toNullableString(row.ecli),
          court: String(row.court),
          country: String(row.country),
          decisionDate: toNullableString(row.decision_date),
          decisionType: toNullableString(row.decision_type),
          // oxlint-disable-next-line typescript/strict-boolean-expressions -- row.headline from DB (any)
          excerpt: row.headline
            ? stripTags(JSON.stringify(row.headline))
            : null,
        })),
      };
    },
  }),

  readDecision: defineTool({
    name: "readDecision",
    description:
      "Read the full text of a court decision by its ID. " +
      "Returns the decision text truncated to maxChars.",
    inputSchema: valibotSchema(
      v.strictObject({
        decisionId: v.pipe(
          v.string(),
          v.minLength(1),
          v.description("Decision ID returned by searchCaseLaw"),
        ),
        maxChars: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.maxValue(32_000),
            v.description("Maximum characters to return (default 8000)"),
          ),
          8000,
        ),
      }),
    ),
    execute: async ({ decisionId, maxChars }) => {
      const result = await scopedDb((tx) =>
        tx.execute(sql`
          SELECT
            d.id,
            d.case_number,
            d.ecli,
            d.court,
            d.country,
            d.decision_date,
            d.decision_type,
            sd.searchable_text AS fulltext
          FROM case_law_decisions d
          JOIN case_law_search_documents sd
            ON sd.decision_id = d.id
          WHERE d.id = ${decisionId}
          LIMIT 1
        `),
      );

      if (result.length === 0) {
        return { error: "Decision not found" };
      }

      const row = result.at(0);
      if (!isRecord(row)) {
        return { error: "Decision not found" };
      }
      const fulltext = typeof row.fulltext === "string" ? row.fulltext : "";
      const truncated =
        fulltext.length > maxChars
          ? `${fulltext.slice(0, maxChars)}…`
          : fulltext;

      return {
        decisionId: String(row.id),
        caseNumber: String(row.case_number),
        ecli: toNullableString(row.ecli),
        court: String(row.court),
        country: String(row.country),
        decisionDate: toNullableString(row.decision_date),
        decisionType: toNullableString(row.decision_type),
        text: truncated,
        truncatedAt: fulltext.length > maxChars ? maxChars : null,
      };
    },
  }),

  getDecisionCitations: defineTool({
    name: "getDecisionCitations",
    description:
      "Follow the citation graph of a court decision. " +
      "Returns decisions that cite or are cited by the " +
      "given decision.",
    inputSchema: valibotSchema(
      v.strictObject({
        decisionId: v.pipe(
          v.string(),
          v.minLength(1),
          v.description("Decision ID to follow citations for"),
        ),
        direction: v.pipe(
          v.picklist(["citing", "cited"]),
          v.description(
            "citing = decisions that cite this one; " +
              "cited = decisions this one cites",
          ),
        ),
        limit: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.maxValue(50),
            v.description("Max results (default 10)"),
          ),
          10,
        ),
      }),
    ),
    execute: async ({ decisionId, direction, limit }) => {
      const isCiting = direction === "citing";

      const result = await scopedDb((tx) =>
        tx.execute(
          isCiting
            ? sql`
              SELECT
                d.id,
                d.case_number,
                d.ecli,
                d.court,
                d.country,
                d.decision_date,
                d.decision_type
              FROM case_law_citations c
              JOIN case_law_decisions d
                ON d.id = c.citing_decision_id
              WHERE c.cited_decision_id = ${decisionId}
              ORDER BY d.decision_date DESC NULLS LAST
              LIMIT ${limit}
            `
            : sql`
              SELECT
                d.id,
                d.case_number,
                d.ecli,
                d.court,
                d.country,
                d.decision_date,
                d.decision_type
              FROM case_law_citations c
              JOIN case_law_decisions d
                ON d.id = c.cited_decision_id
              WHERE c.citing_decision_id = ${decisionId}
                AND c.cited_decision_id IS NOT NULL
              ORDER BY d.decision_date DESC NULLS LAST
              LIMIT ${limit}
            `,
        ),
      );

      return {
        direction,
        resultCount: result.length,
        decisions: result.map((row: Record<string, unknown>) => ({
          decisionId: String(row.id),
          caseNumber: String(row.case_number),
          ecli: toNullableString(row.ecli),
          court: String(row.court),
          country: String(row.country),
          decisionDate: toNullableString(row.decision_date),
          decisionType: toNullableString(row.decision_type),
        })),
      };
    },
  }),

  getCourtHierarchy: defineTool({
    name: "getCourtHierarchy",
    description:
      "List available jurisdictions and their court tiers. " +
      "Use this to discover which countries and court " +
      "levels are available for case law search.",
    inputSchema: valibotSchema(
      v.strictObject({
        country: v.optional(
          v.pipe(
            v.string(),
            v.minLength(2),
            v.maxLength(3),
            v.description(
              "ISO country code to filter by " +
                "(alpha-3, e.g. CZE, SVK, POL, AUT, EU)",
            ),
          ),
        ),
      }),
    ),
    execute: async ({ country: rawCountry }) => {
      const country = rawCountry?.toUpperCase();
      const weightMap = await loadCourtWeights();

      const jurisdictions: {
        country: string;
        courts: {
          pattern: string;
          tier: number;
          tierLabel: string;
          weight: number;
        }[];
      }[] = [];

      for (const [code, entries] of weightMap) {
        if (country && code !== country) {
          continue;
        }
        jurisdictions.push({
          country: code,
          courts: entries.map((e) => ({
            pattern: e.pattern.source,
            tier: e.tier,
            tierLabel: e.tierLabel,
            weight: e.weight,
          })),
        });
      }

      return { jurisdictions };
    },
  }),
});
