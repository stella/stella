import * as v from "valibot";

import { SEARCH_EXCERPTS } from "@stll/api-contract/search";

// No default: each handler owns its own. Spelled out per literal; the schema
// test holds these literals to `SEARCH_EXCERPTS`.
const [shortExcerpt, mediumExcerpt, longExcerpt] = SEARCH_EXCERPTS;

/** How much of the matched passage a case-law search returns per hit. */
export const searchExcerptSchema = v.union([
  v.literal(shortExcerpt),
  v.literal(mediumExcerpt),
  v.literal(longExcerpt),
]);
