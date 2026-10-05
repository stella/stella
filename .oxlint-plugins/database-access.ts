// Pure database operation vocabulary shared by AST rules and source guards.

export const MUTATION_METHODS: ReadonlySet<string> = new Set([
  "insert",
  "update",
  "delete",
]);

export const isDatabaseHandleName = (name: string): boolean =>
  name === "tx" ||
  name === "db" ||
  name === "trx" ||
  /[a-z](?:Tx|Db)$/u.test(name);

// Shared by schema-only import validation and the write rules. Schema-only
// modules reject these operations regardless of a receiver's local alias.
export const isDatabaseOperationMethod = (name: string): boolean =>
  MUTATION_METHODS.has(name) ||
  [
    "select",
    "selectDistinct",
    "selectDistinctOn",
    "query",
    "execute",
    "transaction",
    "findFirst",
    "findMany",
    "unsafe",
    "begin",
  ].includes(name);
