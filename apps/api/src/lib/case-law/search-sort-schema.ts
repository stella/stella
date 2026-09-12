import { t } from "elysia";

import { SEARCH_SORTS } from "@stll/api-contract/search";

// A literal union rather than `UnionEnum`: Elysia coerces an absent optional
// `UnionEnum` to its first member, and each handler owns its default. Spelled
// out per literal so Eden infers the union rather than `never` from a mapped
// array; the schema test holds these literals to `SEARCH_SORTS`.
const [relevanceSort, newestSort] = SEARCH_SORTS;

/** The sort a case-law search or a saved research query may name. */
export const searchSortSchema = t.Union([
  t.Literal(relevanceSort),
  t.Literal(newestSort),
]);
