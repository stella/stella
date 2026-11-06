import * as v from "valibot";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";

import { passthroughId } from "./projection-fields";

/**
 * list_case_law_courts. Source of truth: `listCourtsTool`
 * (`case-law-court-catalog-tool.ts`). One page of the courts the corpus holds
 * for a country under the source policy, one entry per court, tiers apex
 * first. `value` is the spelling `search_case_law` accepts in `courts`;
 * `aliases` are the court's other stored spellings, which search facets may
 * name instead. `key` is the court's identity: spellings of one court on two
 * pages share it. `nextCursor` reads the next page; null on the last.
 */
export const CASE_LAW_COURT_CATALOG_PROJECTION = v.strictObject({
  country: v.string(),
  courts: v.array(
    v.strictObject({
      tierLabel: v.picklist(COURT_TIER_LABELS),
      courts: v.array(
        v.strictObject({
          key: v.string(),
          value: v.string(),
          aliases: v.array(v.string()),
        }),
      ),
    }),
  ),
  nextCursor: v.nullable(passthroughId()),
});
