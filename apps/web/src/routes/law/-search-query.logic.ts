import * as v from "valibot";

import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract/limits";

export const optionalLawSearchQuerySchema = v.optional(
  v.pipe(
    v.string(),
    v.trim(),
    v.maxLength(SEARCH_QUERY_MAX_LENGTH),
    v.transform((value) => (value.length > 0 ? value : undefined)),
  ),
);
