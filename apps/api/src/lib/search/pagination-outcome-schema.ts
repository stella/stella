import { t } from "elysia";

import {
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET,
} from "@stll/api-contract/search";

export const searchPaginationOutcomeSchema = t.Union([
  t.Object(
    { type: t.Literal(SEARCH_PAGINATION_COMPLETE.type) },
    { additionalProperties: false },
  ),
  t.Object(
    {
      type: t.Literal(SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET.type),
      reason: t.Literal(SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET.reason),
    },
    { additionalProperties: false },
  ),
]);
