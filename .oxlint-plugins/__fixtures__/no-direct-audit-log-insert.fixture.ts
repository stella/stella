import { auditLogs as auditLogTable } from "@/api/db/schema";

declare const tx: {
  insert: (table: unknown) => unknown;
};
declare const auditLogs: unknown;
declare const entities: unknown;
declare const reportingTable: unknown;

// Direct insert into the known audit table: the rule must report it.
// oxlint-disable-next-line no-direct-audit-log-insert/no-direct-audit-log-insert
const _direct = tx.insert(auditLogs);

// Other tables are ordinary Drizzle writes.
const _entityInsert = tx.insert(entities);

// An imported alias of the audit table is the same prohibited write.
// oxlint-disable-next-line no-direct-audit-log-insert/no-direct-audit-log-insert
const _alias = tx.insert(auditLogTable);

// An unrelated table with a different local name remains valid.
const _reportingInsert = tx.insert(reportingTable);

export const __noDirectAuditLogInsertFixture = {
  _direct,
  _entityInsert,
  _alias,
  _reportingInsert,
};
