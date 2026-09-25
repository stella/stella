import type { ScopedDb } from "@/api/db/safe-db";
import {
  createPgFtsSearchReader,
  pgFtsSearchMaintenance,
} from "@/api/lib/search/pg-fts-provider";
import type { SearchMaintenance, SearchReader } from "@/api/lib/search/types";

export const getSearchReader = (scopedDb: ScopedDb): SearchReader =>
  createPgFtsSearchReader(scopedDb);

export const getSearchMaintenance = (): SearchMaintenance =>
  pgFtsSearchMaintenance;
