import * as v from "valibot";

import type { AgentInputNormalizationAnnotation } from "@stll/agent-input";
import { apiDateSchema } from "@stll/api-contract/api-date";
import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import {
  CASE_LAW_SEARCH_FACET_NAMES,
  DEFAULT_SEARCH_SORT,
  SEARCH_SORTS,
} from "@stll/api-contract/search";

import { CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH } from "@/api/lib/legal-search/corpus-search-cursor";
import { LIMITS } from "@/api/lib/limits";
import type { SearchCaseLawTexts } from "@/api/mcp/case-law-search-guidance";
import {
  countryInputSchema,
  countryNormalization,
  cursorInput,
  FILTER_NORMALIZATION,
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
      facets: v.optional(
        v.pipe(
          v.array(v.picklist(CASE_LAW_SEARCH_FACET_NAMES)),
          v.maxLength(CASE_LAW_SEARCH_FACET_NAMES.length),
          v.description("Opt-in facet names; first phrasing, page one only."),
        ),
        [],
      ),
      queries: v.optional(
        v.pipe(
          v.array(
            v.pipe(
              v.string(),
              v.minLength(LIMITS.mcpNonEmptyMin),
              v.maxLength(LIMITS.searchQueryMaxLength),
            ),
          ),
          v.minLength(LIMITS.mcpNonEmptyMin),
          v.maxLength(LIMITS.caseLawSearchQueriesMax),
          v.description(texts.queries),
        ),
      ),
      limit: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(LIMITS.mcpPageSizeMin),
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
          v.minLength(LIMITS.mcpNonEmptyMin),
          v.maxLength(LIMITS.caseLawCourtNameMaxChars),
          v.description("Filter by court name"),
        ),
      ),
      courts: v.optional(
        v.pipe(
          v.array(
            v.pipe(
              v.string(),
              v.minLength(LIMITS.mcpNonEmptyMin),
              v.maxLength(LIMITS.caseLawCourtNameMaxChars),
            ),
          ),
          v.minLength(LIMITS.mcpNonEmptyMin),
          v.maxLength(LIMITS.caseLawCourtsFilterMax),
          v.description(texts.courts),
        ),
      ),
      category: v.optional(
        v.pipe(
          v.string(),
          v.minLength(LIMITS.mcpNonEmptyMin),
          v.maxLength(LIMITS.caseLawFilterValueMaxChars),
          v.description(
            'Exact publisher category from metadata.category, for example "A" or "B"; this does not imply Sbírka publication. Applied to live rows within the bounded candidate scan; corpus-index facets and total are unavailable.',
          ),
        ),
      ),
      provision: v.optional(
        v.pipe(
          v.string(),
          v.nonEmpty(),
          v.maxLength(LIMITS.caseLawProvisionFilterMaxLength),
          v.description(
            'Only decisions citing this provision, as a lawyer writes it: "§ 316 odst. 2 ZP", "§ 52 písm. g) zákoníku práce", "čl. 10 Listiny", "Article 6(1)(a) GDPR". EU provisions work for every decision country. A section includes its subsections. Abbreviations name the act in force today; cite an earlier act by number (č. 65/1965 Sb.). With queries: topic decisions applying it. Without: every citing decision, exact total.',
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
          v.minLength(LIMITS.mcpNonEmptyMin),
          v.maxLength(LIMITS.mcpLanguageCodeMaxChars),
          v.description("Filter by language code"),
        ),
      ),
      decision_type: v.optional(
        v.pipe(
          v.string(),
          v.minLength(LIMITS.mcpNonEmptyMin),
          v.maxLength(LIMITS.caseLawFilterValueMaxChars),
          v.description("Filter by decision type"),
        ),
      ),
      source_id: v.optional(uuidInputSchema("Filter by source ID")),
      date_from: v.optional(
        v.pipe(
          apiDateSchema,
          v.maxLength(LIMITS.mcpIsoDateMaxChars),
          v.description("Filter decisions from this ISO date (YYYY-MM-DD)"),
        ),
      ),
      date_to: v.optional(
        v.pipe(
          apiDateSchema,
          v.maxLength(LIMITS.mcpIsoDateMaxChars),
          v.description("Filter decisions up to this ISO date (YYYY-MM-DD)"),
        ),
      ),
      sort: v.optional(
        v.pipe(
          v.picklist(SEARCH_SORTS),
          v.description(
            `Result order; defaults to '${DEFAULT_SEARCH_SORT}'. 'relevance' blends text match with citation authority and court rank; 'newest' orders by decision date, undated decisions last. A query naming a decision outright (docket number, ECLI) is answered by identity lookup, which ignores this option.`,
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
