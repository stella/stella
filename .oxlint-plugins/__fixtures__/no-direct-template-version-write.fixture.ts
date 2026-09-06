import * as schema from "@/api/db/schema";
import { templateVersions as versions } from "@/api/db/schema";

declare const tx: {
  delete: (table: unknown) => unknown;
  insert: (table: unknown) => unknown;
  update: (table: unknown) => unknown;
};
declare const unrelatedTable: unknown;

// oxlint-disable-next-line no-direct-template-version-write/no-direct-template-version-write -- fixture: aliased template-version inserts must be rejected
const _insert = tx.insert(versions);
// oxlint-disable-next-line no-direct-template-version-write/no-direct-template-version-write -- fixture: namespace template-version updates must be rejected
const _update = tx.update(schema.templateVersions);
// oxlint-disable-next-line no-direct-template-version-write/no-direct-template-version-write -- fixture: template-version deletes must be rejected
const _delete = tx.delete(versions);

const _unrelatedInsert = tx.insert(unrelatedTable);
// oxlint-disable-next-line eslint/no-shadow -- fixture: a local binding that shadows the imported table must remain valid
const _shadowedInsert = (versions: unknown) => tx.insert(versions);
// oxlint-disable-next-line eslint/no-shadow -- fixture: a local binding that shadows the schema namespace must remain valid
const _shadowedNamespaceUpdate = (schema: { templateVersions: unknown }) =>
  tx.update(schema.templateVersions);

export const __noDirectTemplateVersionWriteFixture = {
  _delete,
  _insert,
  _shadowedInsert,
  _shadowedNamespaceUpdate,
  _unrelatedInsert,
  _update,
};
