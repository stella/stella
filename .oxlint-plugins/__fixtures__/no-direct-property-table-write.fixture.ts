import { properties as propertyTable } from "@/api/db/schema";

declare const tx: {
  insert: (table: unknown) => unknown;
  update: (table: unknown) => unknown;
};
declare const properties: unknown;
declare const entities: unknown;
declare const reportingTable: unknown;

// An imported alias of the properties table is the same prohibited write:
// the binding is tracked by its import, not by its local spelling.
// oxlint-disable-next-line no-direct-property-table-write/no-direct-property-table-write
const _alias = tx.insert(propertyTable);
// oxlint-disable-next-line no-direct-property-table-write/no-direct-property-table-write
const _aliasUpdate = tx.update(propertyTable);

// Other tables are ordinary Drizzle writes.
const _entityInsert = tx.insert(entities);

// An unrelated table with a different local name remains valid.
const _reportingInsert = tx.insert(reportingTable);

// A local named `properties` that was never imported from the schema module
// is not tracked: the rule only follows bindings introduced by an
// `@/api/db/schema` import, so a same-named local stays valid.
const _localInsert = tx.insert(properties);
const _localUpdate = tx.update(properties);

// A nested declaration that reuses the imported alias's name shadows the
// import for the rest of its scope: the rule resolves the argument through
// real scope analysis, so this parameter binds its own local `propertyTable`
// and is never reported, even though the outer scope's `propertyTable` is.
// oxlint-disable-next-line eslint/no-shadow -- fixture: the shadowed parameter must bind its own local, not the imported alias
const _saveShadowed = (propertyTable: unknown) => tx.insert(propertyTable);

export const __noDirectPropertyTableWriteFixture = {
  _alias,
  _aliasUpdate,
  _entityInsert,
  _reportingInsert,
  _localInsert,
  _localUpdate,
  _saveShadowed,
};
