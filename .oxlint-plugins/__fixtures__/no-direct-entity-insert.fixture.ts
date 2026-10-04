import * as schema from "@/api/db/schema";
import { entities as rows } from "@/api/db/schema";

declare const tx: { insert: (table: unknown) => unknown };
declare const unrelatedTable: unknown;

// oxlint-disable-next-line no-direct-entity-insert/no-direct-entity-insert -- fixture: renamed table imports must use the insert owner
const _named = tx.insert(rows);
// oxlint-disable-next-line no-direct-entity-insert/no-direct-entity-insert -- fixture: namespace table imports must use the insert owner
const _namespace = tx.insert(schema.entities);
const tableAlias = rows;
const chainedAlias = tableAlias;
const schemaAlias = schema;
const { entities: extractedAlias } = schemaAlias;
// oxlint-disable-next-line no-direct-entity-insert/no-direct-entity-insert -- fixture: immutable aliases must retain insert ownership
const _alias = tx.insert(chainedAlias);
// oxlint-disable-next-line no-direct-entity-insert/no-direct-entity-insert -- fixture: schema aliases must retain insert ownership
const _schemaAlias = tx.insert(schemaAlias.entities);
// oxlint-disable-next-line no-direct-entity-insert/no-direct-entity-insert -- fixture: destructured aliases must retain insert ownership
const _destructured = tx.insert(extractedAlias);
// expect-clean: no-direct-entity-insert/no-direct-entity-insert
const _unrelated = tx.insert(unrelatedTable);

export const __namedEntityInsertFixture = {
  _named,
  _namespace,
  _alias,
  _schemaAlias,
  _destructured,
  _unrelated,
};
