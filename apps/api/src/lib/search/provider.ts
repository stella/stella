import { env } from "@/api/env";
import { paradedbProvider } from "@/api/lib/search/paradedb-provider";
import { pgFtsProvider } from "@/api/lib/search/pg-fts-provider";
import type { SearchProvider } from "@/api/lib/search/types";

/**
 * Returns the active search provider based on
 * SEARCH_PROVIDER env var. Defaults to pg-fts.
 */
export const getSearchProvider = (): SearchProvider => {
  switch (env.SEARCH_PROVIDER) {
    case "paradedb":
      return paradedbProvider;
    case "pg-fts":
      return pgFtsProvider;
    default:
      return pgFtsProvider;
  }
};
