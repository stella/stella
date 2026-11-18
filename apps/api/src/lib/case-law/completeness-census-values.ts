// parser-output-unchanged: These census outcomes and scope statuses configure census persistence and responses; decision parser output is unchanged.
export const CENSUS_AGGREGATE_UNIT = "slice-memberships";
export const CENSUS_MEASURED_OUTCOMES = [
  "publisher-count",
  "listing-enumerated",
] as const;
export const CENSUS_COUNTED_OUTCOMES = [
  ...CENSUS_MEASURED_OUTCOMES,
  "identity-unproven",
] as const;
export const CENSUS_OUTCOMES = [
  ...CENSUS_COUNTED_OUTCOMES,
  "none-exposed",
] as const;
export const CENSUS_SCOPE_STATUSES = [
  "full-publisher",
  "partial-publisher",
] as const;
