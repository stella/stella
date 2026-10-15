import * as v from "valibot";

// Both tool surfaces consume the court presentation already resolved by the corpus.
export const CASE_LAW_COURT_PROJECTION = v.strictObject({
  court: v.string(),
  courtAbbreviation: v.nullable(v.string()),
});

export const projectCaseLawCourt = ({
  court,
  courtAbbreviation,
}: v.InferOutput<typeof CASE_LAW_COURT_PROJECTION>) => ({
  court,
  courtAbbreviation,
});
