import { rlsDb } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { createIngestionDb } from "@/api/db/scoped";

let ingestionDb: ScopedDb | undefined;

/**
 * Write boundary for the global case-law corpus.
 *
 * The corpus has no tenant: its rows are public court records, and the
 * `stella_ingestion` role this scopes to is granted nothing outside the
 * `case_law_*` tables. It is the counterpart of `caseLawPublicReadDb`
 * for the paths that fill the corpus in and have no request-scoped
 * database of their own. Everything workspace-scoped keeps using the
 * request's own `scopedDb`.
 *
 * Resolved on first use rather than at import: the handle closes over
 * another module's export, so building it at module scope would tie
 * this module's evaluation to that one's order.
 */
export const getCaseLawIngestionDb = (): ScopedDb => {
  ingestionDb ??= createIngestionDb(rlsDb);

  return ingestionDb;
};
