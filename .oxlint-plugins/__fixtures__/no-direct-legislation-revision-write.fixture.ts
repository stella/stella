import { legislationDocuments as versions } from "@/api/db/schema";

declare const tx: {
  insert: (table: unknown) => unknown;
  update: (table: unknown) => unknown;
  delete: (table: unknown) => unknown;
};
declare const reportingTable: unknown;

// Imported aliases retain the revision owner's write restriction.
// oxlint-disable-next-line no-direct-legislation-revision-write/no-direct-legislation-revision-write -- fixture: revision insert outside ingestion
const _insert = tx.insert(versions);
// oxlint-disable-next-line no-direct-legislation-revision-write/no-direct-legislation-revision-write -- fixture: revision update outside ingestion
const _update = tx.update(versions);
// oxlint-disable-next-line no-direct-legislation-revision-write/no-direct-legislation-revision-write -- fixture: revision delete outside ingestion
const _delete = tx.delete(versions);

// expect-clean: no-direct-legislation-revision-write/no-direct-legislation-revision-write
const _reportingInsert = tx.insert(reportingTable);

export const __noDirectLegislationRevisionWriteFixture = {
  _insert,
  _update,
  _delete,
  _reportingInsert,
};
