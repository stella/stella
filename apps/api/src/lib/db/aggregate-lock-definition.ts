/**
 * PostgreSQL needs UPDATE on a table for every row-locking clause, FOR KEY
 * SHARE included. A row aggregate names the role whose transactions take it:
 * "application" rows are locked in transactions on the application role,
 * "owner" rows only in owner transactions, because the application role
 * cannot lock them. The privilege census test holds both to the grants.
 */
export type AggregateLockDefinition =
  | { rank: number; kind: "advisory" }
  | { rank: number; kind: "row"; holder: "application" | "owner" };
