import * as v from "valibot";

import {
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET,
} from "@stll/api-contract/search";

import { projectionBranch } from "../chat/projection-fields";

export const SEARCH_PAGINATION_OUTCOME_SCHEMA = v.union([
  projectionBranch(
    v.strictObject({ type: v.literal(SEARCH_PAGINATION_COMPLETE.type) }),
  ),
  projectionBranch(
    v.strictObject({
      type: v.literal(SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET.type),
      reason: v.literal(SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET.reason),
    }),
  ),
]);
