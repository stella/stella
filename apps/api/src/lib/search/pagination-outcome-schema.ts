import * as v from "valibot";

import {
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET,
} from "@stll/api-contract/search";

export const searchPaginationOutcomeSchema = v.union([
  v.object({ type: v.literal(SEARCH_PAGINATION_COMPLETE.type) }),
  v.object({
    type: v.literal(SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET.type),
    reason: v.literal(SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET.reason),
  }),
]);
