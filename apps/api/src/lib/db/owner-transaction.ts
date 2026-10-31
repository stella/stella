/**
 * PostgreSQL needs UPDATE on a table for every row-locking clause, and the
 * application role has none on some tables (the organization row, for one),
 * so locks on them run only on the connection owner's role. A connection
 * that runs as the owner carries this marker; `withOwnerTransaction` in
 * `aggregate-lock.ts` opens owner transactions only on a marked connection,
 * and owner-held locks accept nothing else.
 */
const OWNER_DATABASE: unique symbol = Symbol("stella.ownerDatabase");

export type OwnerDatabaseMarker = { readonly [OWNER_DATABASE]: true };

/** Declare a connection that runs as the table owner, as `rootDb` does. */
export const markOwnerDatabase = <Database extends object>(
  database: Database,
): Database & OwnerDatabaseMarker =>
  Object.assign(database, { [OWNER_DATABASE]: true as const });
