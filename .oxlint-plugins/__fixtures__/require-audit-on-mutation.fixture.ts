// Passive regression fixture for require-audit-on-mutation.

declare const tx: {
  insert: (value: unknown) => void;
  update: (value: unknown) => void;
  delete: (value: unknown) => void;
};
declare const recordAuditEvent: (transaction: typeof tx) => void;

export const missingAudit = () => {
  // oxlint-disable-next-line require-audit-on-mutation/require-audit-on-mutation -- fixture: mutation has no audit emission
  tx.insert({ id: "one" });
};

export const nestedAuditDoesNotCoverOuterMutation = () => {
  // oxlint-disable-next-line require-audit-on-mutation/require-audit-on-mutation -- fixture: nested audit calls cannot authorize an outer mutation
  tx.update({ id: "two" });
  const nested = () => recordAuditEvent(tx);
  nested();
};

export const auditedMutation = () => {
  tx.delete({ id: "three" });
  recordAuditEvent(tx);
};

export const deliberatelySkippedMutation = () => {
  // audit: skip - scheduler reconciliation has its own durable event
  tx.update({ id: "four" });
};
