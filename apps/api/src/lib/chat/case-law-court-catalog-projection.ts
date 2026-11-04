import * as v from "valibot";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";

/**
 * read_case_law_courts. Source of truth: `listCourtsTool`
 * (`case-law-court-catalog-tool.ts`). Every court the corpus holds for one
 * country, one entry per court, tiers apex first. `value` is the spelling
 * `search_case_law` accepts in `courts`; `aliases` are the court's other
 * stored spellings, which search facets may name instead.
 */
export const CASE_LAW_COURT_CATALOG_PROJECTION = v.strictObject({
  country: v.string(),
  courts: v.array(
    v.strictObject({
      tierLabel: v.picklist(COURT_TIER_LABELS),
      courts: v.array(
        v.strictObject({ value: v.string(), aliases: v.array(v.string()) }),
      ),
    }),
  ),
});
