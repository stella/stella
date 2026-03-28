import { valibotSchema } from "@ai-sdk/valibot";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import type { ScopedDb } from "@/api/db";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";

import { defineTool } from "./chat-tools";

const HEADLINE_CONFIG = "MaxWords=50, MinWords=20";

const toNullableString = (x: unknown): string | null =>
  x === null ? null : JSON.stringify(x);

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
            v.length(2),
            v.toUpperCase(),
            v.description("ISO 3166-1 alpha-2 country code (e.g. CZ, SK)"),
          ),
        ),
        court: v.optional(
          v.pipe(
            v.string(),
            v.maxLength(512),
            v.description("Court name to filter by"),
          ),
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
    execute: async ({ query, country, court, limit }) => {
      const tsQuery = sql`plainto_tsquery('simple', ${query})`;

      const courtFilter = court
        ? sql`AND d.court ILIKE ${`%${escapeLike(court)}%`}`
        : sql``;
      const countryFilter = country ? sql`AND d.country = ${country}` : sql``;

      // Raw SQL: Drizzle lacks tsvector/ts_headline support
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
        WHERE sd.tsv @@ ${tsQuery}
          ${courtFilter}
          ${countryFilter}
        ORDER BY
          ts_rank(sd.tsv, ${tsQuery}) DESC,
          sd.decision_id DESC
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
});
