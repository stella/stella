import { pgFtsProvider } from "@/api/lib/search/pg-fts-provider";
import type { SearchProvider } from "@/api/lib/search/types";

export const getSearchProvider = (): SearchProvider => pgFtsProvider;
