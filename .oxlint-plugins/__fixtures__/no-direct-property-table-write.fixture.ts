import { properties as propertyTable } from "@/api/db/schema";

declare const tx: {
  insert: (table: unknown) => unknown;
  update: (table: unknown) => unknown;
};
declare const properties: unknown;
declare const entities: unknown;
declare const reportingTable: unknown;

// Direct insert into the known properties table: the rule must report it.
// oxlint-disable-next-line no-direct-property-table-write/no-direct-property-table-write
const _directInsert = tx.insert(properties);

// Direct update of the known properties table: the rule must report it too.
// oxlint-disable-next-line no-direct-property-table-write/no-direct-property-table-write
const _directUpdate = tx.update(properties);

// Other tables are ordinary Drizzle writes.
const _entityInsert = tx.insert(entities);

// An imported alias of the properties table is the same prohibited write.
// oxlint-disable-next-line no-direct-property-table-write/no-direct-property-table-write
const _alias = tx.insert(propertyTable);

// An unrelated table with a different local name remains valid.
const _reportingInsert = tx.insert(reportingTable);

export const __noDirectPropertyTableWriteFixture = {
  _directInsert,
  _directUpdate,
  _entityInsert,
  _alias,
  _reportingInsert,
};
