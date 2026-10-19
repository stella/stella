import type { ScopedDb } from "@/api/db/safe-db";
import { createPgFtsSearchReader } from "@/api/lib/search/pg-fts-provider";
import type { SearchReader } from "@/api/lib/search/types";

export const getSearchReader = (scopedDb: ScopedDb): SearchReader =>
  createPgFtsSearchReader(scopedDb);
