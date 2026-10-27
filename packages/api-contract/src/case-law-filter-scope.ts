import * as v from "valibot";

export const caseLawScopedFiltersSchema = v.object({
  court: v.optional(v.pipe(v.string(), v.maxLength(512))),
  lang: v.optional(v.pipe(v.string(), v.maxLength(16))),
  type: v.optional(v.pipe(v.string(), v.maxLength(128))),
  sourceId: v.optional(v.pipe(v.string(), v.uuid())),
});
export const CASE_LAW_SCOPED_FILTER_FIELDS = v.keyof(
  caseLawScopedFiltersSchema,
).options;
export type CaseLawScopedFilters = v.InferOutput<
  typeof caseLawScopedFiltersSchema
>;
export type CaseLawScopedFilterField =
  (typeof CASE_LAW_SCOPED_FILTER_FIELDS)[number];
export const caseLawFilterValidationSchema = v.object({
  filters: caseLawScopedFiltersSchema,
  removed: v.pipe(
    v.array(
      v.object({
        field: v.picklist(CASE_LAW_SCOPED_FILTER_FIELDS),
        value: v.pipe(v.string(), v.maxLength(512)),
        countries: v.pipe(
          v.array(v.pipe(v.string(), v.maxLength(3))),
          v.maxLength(32),
        ),
      }),
    ),
    v.maxLength(CASE_LAW_SCOPED_FILTER_FIELDS.length),
  ),
});

type NormalizeCaseLawCountryFiltersOptions = {
  country: string;
  filters: CaseLawScopedFilters;
  countriesByField: Readonly<
    Record<CaseLawScopedFilterField, readonly string[]>
  >;
};

/** Membership comes from the public corpus, never a truncated result-set facet. */
export const normalizeCaseLawCountryFilters = ({
  country,
  filters,
  countriesByField,
}: NormalizeCaseLawCountryFiltersOptions) => {
  const entries: [CaseLawScopedFilterField, string][] = [];
  const removed: v.InferOutput<
    typeof caseLawFilterValidationSchema
  >["removed"] = [];
  for (const field of CASE_LAW_SCOPED_FILTER_FIELDS) {
    const value = filters[field];
    if (value === undefined) {
      continue;
    }
    const countries = countriesByField[field];
    if (countries.includes(country.toUpperCase())) {
      entries.push([field, value]);
    } else {
      removed.push({ field, value, countries: [...countries] });
    }
  }
  return {
    filters: v.parse(caseLawScopedFiltersSchema, Object.fromEntries(entries)),
    removed,
  };
};
