import { decisionDocketColumns } from "@/api/handlers/case-law/ingestion/pipeline/decision-docket-columns";
import { primaryReferenceTypeFromStored } from "@/api/lib/legal-search/decision-primary-reference";

/**
 * What `backfill-citation-keys.ts` does to one row, separated from the script
 * so a test can hold it to the row writer: a script module runs on import.
 */

/** Fill only what is missing, or rewrite every key the rule now spells differently. */
export type CitationKeyScope = "missing" | "stale";

/** A decision row as the backfill reads it. */
export type StoredDecisionKeys = {
  caseNumber: string;
  caseNumberType: unknown;
  country: string;
  citationKey: string | null;
  docketFamilyKey: string | null;
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
    caseNumber: row.caseNumber,
    caseNumberType: primaryReferenceTypeFromStored(row.caseNumberType),
    country: row.country,
  });
  return scope === "missing"
    ? {
        citationKey: row.citationKey ?? derived.citationKey,
        docketFamilyKey: row.docketFamilyKey ?? derived.docketFamilyKey,
      }
    : {
        citationKey: derived.citationKey,
        docketFamilyKey: derived.docketFamilyKey,
      };
};
