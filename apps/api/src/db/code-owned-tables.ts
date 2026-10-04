/**
 * Tables whose rows the application writes from its own declarations, for
 * example `scheduler_jobs`, upserted from `DECLARED_SCHEDULER_JOBS` at every
 * boot.
 *
 * A migration that inserts or updates such a row creates a second owner: the
 * copy it writes drifts from what the code declares, and a database migrated
 * at deploy time ends up with different rows from one migrated from scratch
 * later. `scripts/check-migration-safety.ts` therefore refuses INSERT, UPDATE
 * and MERGE against these names in a migration, with no acknowledgement;
 * DELETE stays allowed, so a migration can remove a row the code no longer
 * owns.
 *
 * No imports, so the checker can load this file from `scripts/` without the
 * API's path aliases; `code-owned-tables.test.ts` proves every name is a table
 * the schema declares.
 */
export const CODE_OWNED_TABLES = ["scheduler_jobs"] as const;
