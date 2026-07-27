import { rlsDb } from "@/api/db/root";
import { createIngestionDb } from "@/api/db/scoped";

/**
 * Write boundary for the global case-law corpus.
 *
 * The corpus has no tenant: its rows are public court records, and the
 * `stella_ingestion` role this scopes to is granted nothing outside the
 * `case_law_*` tables. It is the counterpart of `caseLawPublicReadDb`
 * for the paths that fill the corpus in and have no request-scoped
 * database of their own. Everything workspace-scoped keeps using the
 * request's own `scopedDb`.
 */
export const caseLawIngestionDb = createIngestionDb(rlsDb);
