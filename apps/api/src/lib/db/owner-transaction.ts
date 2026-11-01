/**
 * PostgreSQL needs UPDATE on a table for every row-locking clause, and the
 * application role has none on some tables (the organization row, for one),
 * so locks on them run only on the connection owner's role. A connection
 * that runs as the owner is registered here where it is constructed; the
 * registry never touches the connection object itself. Only `db/root.ts`,
 * `lib/db/maintenance-db.ts` and test helpers may register one (see
 * scripts/ownership/owner-database.ts). `withOwnerAggregateTransaction` in
 * `aggregate-lock.ts` refuses any connection not registered here, and
 * owner-held locks accept only the transactions it opens.
 */
const ownerDatabases = new WeakSet<object>();

/** Register the owner connection `create` builds, at its construction site. */
export const createOwnerDatabase = <Database extends object>(
  create: () => Database,
): Database => {
  const database = create();
  ownerDatabases.add(database);
  return database;
};

/** Whether `database` was registered as an owner connection. */
export const isOwnerDatabase = (database: object): boolean =>
  ownerDatabases.has(database);
