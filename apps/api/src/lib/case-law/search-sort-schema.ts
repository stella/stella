import * as v from "valibot";

import { SEARCH_SORTS } from "@stll/api-contract/search";

// No default: each handler owns its own. Spelled out per literal; the schema
// test holds these literals to `SEARCH_SORTS`.
const [relevanceSort, newestSort] = SEARCH_SORTS;

/** The sort a case-law search or a saved research query may name. */
export const searchSortSchema = v.union([
  v.literal(relevanceSort),
  v.literal(newestSort),
]);
