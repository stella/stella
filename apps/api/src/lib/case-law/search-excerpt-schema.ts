import { t } from "elysia";

import { SEARCH_EXCERPTS } from "@stll/api-contract/search";

// A literal union rather than `UnionEnum`: Elysia coerces an absent optional
// `UnionEnum` to its first member, and each handler owns its default. Spelled
// out per literal so Eden infers the union rather than `never` from a mapped
// array; the schema test holds these literals to `SEARCH_EXCERPTS`.
const [shortExcerpt, mediumExcerpt, longExcerpt] = SEARCH_EXCERPTS;

/** How much of the matched passage a case-law search returns per hit. */
export const searchExcerptSchema = t.Union([
  t.Literal(shortExcerpt),
  t.Literal(mediumExcerpt),
  t.Literal(longExcerpt),
]);
