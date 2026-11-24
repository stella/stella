import { type SQL, sql, type SQLWrapper } from "drizzle-orm";

type HeldDocketPredicateOptions = {
  candidateKey: SQLWrapper;
  candidateNumber: SQLWrapper;
  expectedKeys: SQL;
  expectedSpellings: SQL;
};

/** A single bounded JSON parameter retains array shape in every Drizzle driver. */
export const heldDocketStrings = (values: readonly string[]) =>
  sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::text::jsonb))`;

/** Keep the candidate columns bare so both live matching and census use their indexes. */
export const heldDocketPredicate = ({
  candidateKey,
  candidateNumber,
  expectedKeys,
  expectedSpellings,
}: HeldDocketPredicateOptions) => sql`(
  ${candidateKey} = ANY(${expectedKeys})
  OR (${candidateKey} IS NULL AND ${candidateNumber} = ANY(${expectedSpellings}))
)`;
