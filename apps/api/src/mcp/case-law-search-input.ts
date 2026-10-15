import * as v from "valibot";

import type { AgentInputNormalizationAnnotation } from "@stll/agent-input";
import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import { DEFAULT_SEARCH_SORT, SEARCH_SORTS } from "@stll/api-contract/search";

import { CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH } from "@/api/lib/legal-search/corpus-search-cursor";
import { LIMITS } from "@/api/lib/limits";
import type { SearchCaseLawTexts } from "@/api/mcp/case-law-search-guidance";
import {
  countryInputSchema,
  countryNormalization,
  cursorInput,
  FILTER_NORMALIZATION,
  ISO_DATE_SCHEMA,
  MAX_SEARCH_LIMIT,
  nullAsAbsent,
  uuidInputSchema,
} from "@/api/mcp/input-schemas";

/** Named because the country ask names the call to change; a census test binds
 *  this to the tool's own `name` so a rename cannot leave a stale hint. */
export const SEARCH_CASE_LAW_TOOL = "search_case_law";

/**
 * The corpus countries `search_case_law` answers for. Rendered into both the
 * input description and the rejection hint, so a caller reading either sees
 * the exact country codes the corpus admits.
 */
export const ADMITTED_CASE_LAW_COUNTRIES = PUBLIC_CASE_LAW_COUNTRIES.join(", ");

/**
 * A merged cursor carries one sub-cursor per query, JSON-wrapped and
 * base64url-encoded. The sub-cursor bound comes from the engine cursor's own
 * codec rather than a number written here: under query expansion an engine
 * cursor carries a 64-character dictionary identity, and a cap guessed below
 * what the engine emits rejects a page boundary this tool itself handed out.
 * The envelope adds three JSON characters per entry, two for the brackets,
 * and four base64 characters per three bytes.
 */
export const CASE_LAW_SEARCH_CURSOR_MAX_LENGTH = Math.ceil(
  (((CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH + 3) *
    LIMITS.caseLawSearchQueriesMax +
    2) *
    4) /
    3,
);

/** Kinds the search input reads through the shared agent-input readers. */
export const SEARCH_CASE_LAW_INPUT_NORMALIZATION = {
  country: countryNormalization({
    spelling: "alpha-3",
    admitted: PUBLIC_CASE_LAW_COUNTRIES,
    tool: SEARCH_CASE_LAW_TOOL,
  }),
  court: FILTER_NORMALIZATION,
  courts: { kind: "string-list" },
  category: FILTER_NORMALIZATION,
  language: FILTER_NORMALIZATION,
  decision_type: FILTER_NORMALIZATION,
} as const satisfies Readonly<
  Record<string, AgentInputNormalizationAnnotation>
>;

export const searchCaseLawArgsSchema = (texts: SearchCaseLawTexts) =>
  nullAsAbsent(
    v.strictObject({
      queries: v.pipe(
        v.array(
          v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(LIMITS.searchQueryMaxLength),
          ),
        ),
        v.minLength(1),
        v.maxLength(LIMITS.caseLawSearchQueriesMax),
        v.description(texts.queries),
      ),
      limit: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(MAX_SEARCH_LIMIT),
          v.description(texts.limit),
        ),
      ),
      cursor: cursorInput({
        description:
          "Opaque cursor from a previous search_case_law call. It continues the same queries, in the same order. It carries each query's own position and not what earlier pages emitted, so a decision several queries return can appear on more than one page: key results by decisionId.",
        maxLength: CASE_LAW_SEARCH_CURSOR_MAX_LENGTH,
      }),
      court: v.optional(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(512),
          v.description("Filter by court name"),
        ),
      ),
      courts: v.optional(
        v.pipe(
          v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
          v.minLength(1),
          v.maxLength(16),
          v.description(texts.courts),
        ),
      ),
      category: v.optional(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(128),
          v.description(
            'Exact publisher category from metadata.category, for example "A" or "B"; this does not imply Sbírka publication. Applied to live rows within the bounded candidate scan; corpus-index facets and total are unavailable.',
          ),
        ),
      ),
      has_legal_sentence: v.optional(
        v.pipe(
          v.boolean(),
          v.description(
            "True requires a non-empty stored legal sentence (právní věta); false selects decisions without one. Applied to live rows within the bounded candidate scan; corpus-index facets and total are unavailable.",
          ),
        ),
      ),
      country: countryInputSchema(
        `Required corpus country. Admitted: ${ADMITTED_CASE_LAW_COUNTRIES}.`,
      ),
      language: v.optional(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(8),
          v.description("Filter by language code"),
        ),
      ),
      decision_type: v.optional(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(128),
          v.description("Filter by decision type"),
        ),
      ),
      source_id: v.optional(uuidInputSchema("Filter by source ID")),
      date_from: v.optional(
        v.pipe(
          ISO_DATE_SCHEMA,
          v.maxLength(10),
          v.description("Filter decisions from this ISO date (YYYY-MM-DD)"),
        ),
      ),
      date_to: v.optional(
        v.pipe(
          ISO_DATE_SCHEMA,
          v.maxLength(10),
          v.description("Filter decisions up to this ISO date (YYYY-MM-DD)"),
        ),
      ),
      sort: v.optional(
        v.pipe(
          v.picklist(SEARCH_SORTS),
          v.description(
            `Result order; defaults to '${DEFAULT_SEARCH_SORT}'. 'relevance' blends text match with citation authority and court rank; 'newest' orders by decision date and returns only dated decisions. A query naming a decision outright (docket number, ECLI) is answered by identity lookup, which ignores this option.`,
          ),
        ),
      ),
      strict: v.optional(
        v.pipe(
          v.boolean(),
          v.description(
            "Require every word of each query, function words included. Off by default: a query phrased as a question carries words no judgment is written with, and `searches[].queryUsed` reports what was required. Pass true when every word matters.",
          ),
        ),
      ),
    }),
  );
