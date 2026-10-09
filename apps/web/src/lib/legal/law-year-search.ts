import * as v from "valibot";

/** Router search parsing may decode a numeric year before schema validation. */
export const lawYearSearchSchema = v.optional(
  v.pipe(
    v.union([v.string(), v.number()]),
    v.transform(String),
    v.length(4),
    v.regex(/^\d{4}$/u),
  ),
);
