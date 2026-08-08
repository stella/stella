declare const tx: {
  insert: (table: unknown) => unknown;
};
declare const auditLogs: unknown;
declare const entities: unknown;
declare const aliasedAuditTable: unknown;

// Direct insert into the known audit table: the rule must report it.
// oxlint-disable-next-line no-direct-audit-log-insert/no-direct-audit-log-insert
const _direct = tx.insert(auditLogs);

// Other tables are ordinary Drizzle writes.
const _entityInsert = tx.insert(entities);

// Aliases are deliberately outside this narrow syntactic rule and remain
// visible to the matching ratchet metric.
const _alias = tx.insert(aliasedAuditTable);

export const __noDirectAuditLogInsertFixture = {
  _direct,
  _entityInsert,
  _alias,
};
