import { envBase } from "@/api/env-base";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";

export {
  CORPUS_FAMILIES,
  parseCorpusFamily,
} from "@/api/lib/legal-search/corpus-generation-contract";
export type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";

/**
 * Compatibility boundary for pre-final public backfills. Readers and final
 * projections use the database generation registry. Remove this after those
 * public backfills are retired from every deployment.
 */
export const legacyOperationalCorpusGeneration = (
  family: CorpusFamily,
): string => {
  switch (family) {
    case "case_law":
      return envBase.LEGAL_SEARCH_INDEX_GENERATION;
    case "legislation":
      return "legislation_v1";
    default:
      return family satisfies never;
  }
};
