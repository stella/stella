import { sql } from "drizzle-orm";
import { z } from "zod";

import type { ScopedDb } from "@/api/db";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";

import { defineTool } from "./chat-tools";

const HEADLINE_CONFIG = "MaxWords=50, MinWords=20";

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
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(LIMITS.searchQueryMaxLength)
        .describe("Search query (keywords or phrases)"),
      country: z
        .string()
        .length(2)
        .toUpperCase()
        .optional()
        .describe("ISO 3166-1 alpha-2 country code (e.g. CZ, SK)"),
      court: z.string().max(512).optional().describe("Court name to filter by"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .default(10)
        .describe("Max results to return"),
    }),
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
        resultCount: result.rows.length,
        decisions: result.rows.map((row) => ({
          decisionId: String(row.id),
          caseNumber: String(row.case_number),
          ecli: row.ecli ? String(row.ecli) : null,
          court: String(row.court),
          country: String(row.country),
          decisionDate: row.decision_date ? String(row.decision_date) : null,
          decisionType: row.decision_type ? String(row.decision_type) : null,
          excerpt: row.headline ? stripTags(String(row.headline)) : null,
        })),
      };
    },
  }),
});
