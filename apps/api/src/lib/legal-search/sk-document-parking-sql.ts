/**
 * The deferred-document walk's parking threshold, and the SQL that tests it.
 *
 * A leaf module, importing nothing of the API, because the database schema
 * declares a partial index on this predicate and the queue's parked reads
 * apply it: both sides have to be the same text, and a schema that imported
 * the queue would import the schema back.
 */
import type { Column, SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

/**
 * Attempts after which a decision leaves the walk altogether.
 *
 * A document the source never serves would otherwise come back after
 * every cooldown for as long as the corpus exists, and each return is a
 * download. A parked decision keeps its NULL text, so it stays countable
 * and `requeueParkedDocuments` puts it back when the cause is fixed. A
 * reader who opens it still fetches it directly.
 */
export const MAX_DOCUMENT_FETCH_ATTEMPTS = 8;

/**
 * "This decision has used up its attempts", over the attempt-count column.
 *
 * The threshold is inlined rather than bound: this predicate is part of the
 * definition of `case_law_decisions_document_parked_idx`, and PostgreSQL
 * matches a query against a partial index's predicate only when it can prove
 * the implication from constants. A bound threshold folds to a constant under
 * a custom plan and stays a parameter under a generic one, which would drop
 * the parked reads back to a walk of the whole pending backlog. The value is
 * a code constant, never input.
 */
export const documentFetchParked = (attempts: Column): SQL =>
  sql`${attempts} >= ${sql.raw(String(MAX_DOCUMENT_FETCH_ATTEMPTS))}`;
