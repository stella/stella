import { rlsDb } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { createIngestionDb } from "@/api/db/scoped";

let ingestionDb: ScopedDb | undefined;

/** The refresh scheduler writes global list tables as `stella_ingestion`. */
export const getSanctionsIngestionDb = (): ScopedDb => {
  ingestionDb ??= createIngestionDb(rlsDb);
  return ingestionDb;
};
