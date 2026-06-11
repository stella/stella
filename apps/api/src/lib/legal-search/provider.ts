import { envBase } from "@/api/env-base";
import { corpusIndexProvider } from "@/api/lib/legal-search/corpus-index-provider";
import { pgFtsLegalProvider } from "@/api/lib/legal-search/pg-fts-legal-provider";
import type {
  LegalSearchEngine,
  LegalSearchProvider,
} from "@/api/lib/legal-search/types";

/**
 * Config-driven provider selection. The master cutover switch is
 * `LEGAL_SEARCH_PROVIDER` (default `pg-fts`), so swapping engines is an
 * operational change. Exhaustive switch — adding an engine without a
 * branch fails typecheck.
 */
const providerFor = (engine: LegalSearchEngine): LegalSearchProvider => {
  switch (engine) {
    case "pg-fts":
      return pgFtsLegalProvider;
    case "corpus-index":
      return corpusIndexProvider;
    default:
      return engine satisfies never;
  }
};

export const getLegalSearchProvider = (): LegalSearchProvider =>
  providerFor(envBase.LEGAL_SEARCH_PROVIDER);
