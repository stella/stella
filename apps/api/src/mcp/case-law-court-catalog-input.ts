import * as v from "valibot";

import type { AgentInputNormalizationAnnotation } from "@stll/agent-input";
import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";

import { LIMITS } from "@/api/lib/limits";
import {
  countryInputSchema,
  countryNormalization,
  cursorInput,
  nullAsAbsent,
} from "@/api/mcp/input-schemas";

export const LIST_CASE_LAW_COURTS_TOOL = "list_case_law_courts";

/** A page is one keyset read; it gets the court-filter vocabulary's sub-budget. */
export const LIST_CASE_LAW_COURTS_READ_BUDGET_MS = 1500;

/** The stored court column's length, in characters. */
const COURT_NAME_MAX_CHARS = 512;

/**
 * The longest cursor a page can issue: a one-name JSON array, base64url. A
 * character is at most six bytes once JSON escapes it (`\u0001`), and the
 * array adds four, so the bound holds for any stored name.
 */
const COURT_CURSOR_MAX_LENGTH = Math.ceil(
  ((COURT_NAME_MAX_CHARS * 6 + 4) * 4) / 3,
);

export const listCaseLawCourtsArgsSchema = nullAsAbsent(
  v.strictObject({
    country: countryInputSchema("Corpus country whose courts to list."),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(LIMITS.mcpPageSizeMin),
        v.maxValue(LIMITS.mcpListPageSizeMax),
        v.description(
          `Courts per page; defaults to and at most ${LIMITS.mcpListPageSizeMax}.`,
        ),
      ),
    ),
    cursor: cursorInput({
      description: "nextCursor from the previous page.",
      maxLength: COURT_CURSOR_MAX_LENGTH,
    }),
  }),
);

export const LIST_CASE_LAW_COURTS_INPUT_NORMALIZATION = {
  country: countryNormalization({
    spelling: "alpha-3",
    admitted: PUBLIC_CASE_LAW_COUNTRIES,
    tool: LIST_CASE_LAW_COURTS_TOOL,
  }),
} as const satisfies Readonly<
  Record<string, AgentInputNormalizationAnnotation>
>;
