import { decisionDocketColumns } from "@/api/handlers/case-law/ingestion/pipeline/decision-docket-columns";
import { primaryReferenceTypeFromStored } from "@/api/lib/legal-search/decision-primary-reference";

/**
 * What `backfill-citation-keys.ts` does to one row, separated from the script
 * so a test can hold it to the row writer: a script module runs on import.
 */

/** Fill only what is missing, or rewrite every key the rule now spells differently. */
export type CitationKeyScope = "missing" | "stale";

/**
 * A decision row as the backfill reads it: what it stores, named apart from
 * the columns it writes so the row-writer guard does not read it as a write.
 */
export type StoredDecisionKeys = {
  storedReference: string;
  storedReferenceType: unknown;
  country: string;
  storedCitationKey: string | null;
  storedDocketFamilyKey: string | null;
};

/** The keys a decision row should hold after the pass. */
export type DecisionKeysToWrite = {
  citationKey: string | null;
  docketFamilyKey: string | null;
};

/**
 * A decision's keys as its row writer derives them (`decisionDocketColumns`),
 * so a backfilled row holds what ingestion would have written. Filling what is
 * missing keeps every key already stored; only a recanonicalization rewrites
 * one.
 */
export const decisionKeysToWrite = (
  row: StoredDecisionKeys,
  scope: CitationKeyScope,
): DecisionKeysToWrite => {
  const derived = decisionDocketColumns({
    caseNumber: row.storedReference,
    caseNumberType: primaryReferenceTypeFromStored(row.storedReferenceType),
    country: row.country,
  });
  return scope === "missing"
    ? {
        citationKey: row.storedCitationKey ?? derived.citationKey,
        docketFamilyKey: row.storedDocketFamilyKey ?? derived.docketFamilyKey,
      }
    : {
        citationKey: derived.citationKey,
        docketFamilyKey: derived.docketFamilyKey,
      };
};

/** A decision row's keys before (`stored`, `storedFamily`) and after the pass. */
export type DecisionKeyChange = {
  key: string | null;
  stored: string | null;
  family: string | null;
  storedFamily: string | null;
};

/** Whether the pass rewrites either of a row's keys. */
export const rowKeysChange = ({
  family,
  key,
  stored,
  storedFamily,
}: DecisionKeyChange): boolean => key !== stored || family !== storedFamily;

/**
 * The citation keys whose candidates a batch of decision rewrites changed.
 *
 * A stated sheet names a candidate only while it holds a case-file key
 * (`SHEET_READING_SQL.stated`), so filling or clearing that key alone, under
 * an unchanged citation key, can change which decision a citation resolves
 * to. Citations are matched by citation key, so a row whose either key
 * changed reopens the citations under its old and new citation keys.
 */
export const citationKeysToReopen = (
  rows: readonly DecisionKeyChange[],
): string[] => [
  ...new Set(
    rows
      .filter(rowKeysChange)
      .flatMap(({ key, stored }) =>
        [key, stored].filter((value) => value !== null),
      ),
  ),
];
