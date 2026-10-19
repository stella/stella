import * as v from "valibot";

export const LAW_YEAR_BOUNDS = { minimum: 1000, maximum: 9999 } as const;

/** Router search parsing may decode a numeric year before validation. */
export const lawYearSearchSchema = v.optional(
  v.pipe(
    v.union([v.string(), v.number()]),
    v.transform(String),
    v.length(4),
    v.regex(/^[0-9]{4}$/u),
    v.check(
      (year) =>
        Number(year) >= LAW_YEAR_BOUNDS.minimum &&
        Number(year) <= LAW_YEAR_BOUNDS.maximum,
    ),
  ),
);
