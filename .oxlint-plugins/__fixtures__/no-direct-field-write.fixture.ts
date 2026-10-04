import { cellMetadata, fields as fieldTable } from "@/api/db/schema";

declare const tx: {
  insert: (table: unknown) => unknown;
  update: (table: unknown) => unknown;
  delete: (table: unknown) => unknown;
};
declare const fields: unknown;
declare const entities: unknown;

// Writing a cell value outside the field owner is the prohibited write, under
// any local alias of the table.
// oxlint-disable-next-line no-direct-field-write/no-direct-field-write
const _insert = tx.insert(fieldTable);
// oxlint-disable-next-line no-direct-field-write/no-direct-field-write
const _update = tx.update(fieldTable);
// oxlint-disable-next-line no-direct-field-write/no-direct-field-write
const _delete = tx.delete(fieldTable);
// oxlint-disable-next-line no-direct-field-write/no-direct-field-write
const _lock = tx.insert(cellMetadata);

// Other tables are ordinary Drizzle writes.
// expect-clean: no-direct-field-write/no-direct-field-write
const _entityInsert = tx.insert(entities);

// A local named `fields` that was never imported from the schema module is
// not the table.
// expect-clean: no-direct-field-write/no-direct-field-write
const _localInsert = tx.insert(fields);

export const __noDirectFieldWriteFixture = {
  _insert,
  _update,
  _delete,
  _lock,
  _entityInsert,
  _localInsert,
};
