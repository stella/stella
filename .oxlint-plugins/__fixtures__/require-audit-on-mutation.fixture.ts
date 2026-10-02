// Passive regression fixture for require-audit-on-mutation.

import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { auditedPresignDownload as presign } from "@/api/lib/audited-download";

type Writer = {
  insert: (value: unknown) => void;
  update: (value: unknown) => void;
  delete: (value: unknown) => void;
  execute: (query: unknown) => void;
  transaction: (run: (handle: Writer) => void) => void;
};

declare const tx: Writer;
declare const ctx: { db: Writer };
declare const getDb: () => Writer;
declare const bindings: Parameters<typeof createAuditRecorder>[0];
declare const presignArgs: Parameters<typeof presign>[0];

export const missingAudit = () => {
  // oxlint-disable-next-line require-audit-on-mutation/require-audit-on-mutation -- fixture: mutation has no audit emission
  tx.insert({ id: "one" });
};

export const nestedAuditDoesNotCoverOuterMutation = (
  recordAuditEvent: AuditRecorder,
  transaction: Transaction,
) => {
  // oxlint-disable-next-line require-audit-on-mutation/require-audit-on-mutation -- fixture: nested audit calls cannot authorize an outer mutation
  tx.update({ id: "two" });
  const nested = () => recordAuditEvent(transaction, []);
  nested();
};

export const contextDbReceiver = () => {
  // oxlint-disable-next-line require-audit-on-mutation/require-audit-on-mutation -- fixture: member receiver
  ctx.db.delete({ id: "three" });
};

export const getDbReceiver = () => {
  // oxlint-disable-next-line require-audit-on-mutation/require-audit-on-mutation -- fixture: call receiver
  getDb().insert({ id: "four" });
};

export const transactionParameter = () => {
  tx.transaction((handle) => {
    // oxlint-disable-next-line require-audit-on-mutation/require-audit-on-mutation -- fixture: transaction callback parameter
    handle.update({ id: "five" });
  });
};

export const trxReceiver = (trx: Writer) => {
  // oxlint-disable-next-line require-audit-on-mutation/require-audit-on-mutation -- fixture: trx receiver
  trx.delete({ id: "six" });
};

export const typedTransactionParameter = (connection: Transaction) => {
  // oxlint-disable-next-line require-audit-on-mutation/require-audit-on-mutation -- fixture: raw insert through a parameter typed as a transaction
  void connection.execute(sql`INSERT INTO items (id) VALUES (1)`);
};

export const typedTransactionDelete = (
  connection: Transaction,
  table: Parameters<Transaction["delete"]>[0],
) => {
  // oxlint-disable-next-line require-audit-on-mutation/require-audit-on-mutation -- fixture: parameter typed as a transaction
  void connection.delete(table);
};

const rawDelete = sql`DELETE FROM items WHERE id = ${1}`;
export const rawWriteConst = () => {
  // oxlint-disable-next-line require-audit-on-mutation/require-audit-on-mutation -- fixture: raw delete held in a const
  tx.execute(rawDelete);
};

export const rawUpdate = () => {
  // oxlint-disable-next-line require-audit-on-mutation/require-audit-on-mutation -- fixture: raw update with an interpolated table
  tx.execute(sql`UPDATE ${rawDelete} AS t SET id = 2`);
};

export const localRecorderDoesNotCount = () => {
  const recordAuditEvent = (_handle: Writer) => undefined;
  // oxlint-disable-next-line require-audit-on-mutation/require-audit-on-mutation -- fixture: a same-named local function is not the recorder
  tx.insert({ id: "seven" });
  recordAuditEvent(tx);
};

export const oneWordSkipReason = () => {
  // audit: skip - scheduler
  // oxlint-disable-next-line require-audit-on-mutation/require-audit-on-mutation -- fixture: a one-word reason does not justify the skip
  tx.update({ id: "eight" });
};

export const emptySkipReason = () => {
  // audit: skip
  // oxlint-disable-next-line require-audit-on-mutation/require-audit-on-mutation -- fixture: an empty reason does not justify the skip
  tx.update({ id: "nine" });
};

export const auditedMutation = (
  recordAuditEvent: AuditRecorder,
  transaction: Transaction,
) => {
  // expect-clean: require-audit-on-mutation/require-audit-on-mutation
  tx.delete({ id: "ten" });
  void recordAuditEvent(transaction, []);
};

export const contextRecorder = (
  handler: { recordAuditEvent: AuditRecorder },
  transaction: Transaction,
) => {
  // expect-clean: require-audit-on-mutation/require-audit-on-mutation
  ctx.db.insert({ id: "eleven" });
  void handler.recordAuditEvent(transaction, []);
};

export const destructuredRecorder = (
  handler: { recordAuditEvent: AuditRecorder },
  transaction: Transaction,
) => {
  const { recordAuditEvent } = handler;
  // expect-clean: require-audit-on-mutation/require-audit-on-mutation
  getDb().update({ id: "twelve" });
  void recordAuditEvent(transaction, []);
};

export const factoryRecorder = (transaction: Transaction) => {
  const recordTargetAuditEvent = createAuditRecorder(bindings);
  // expect-clean: require-audit-on-mutation/require-audit-on-mutation
  tx.insert({ id: "thirteen" });
  void recordTargetAuditEvent(transaction, []);
};

export const auditedHelper = async () => {
  // expect-clean: require-audit-on-mutation/require-audit-on-mutation
  tx.insert({ id: "fourteen" });
  await presign(presignArgs);
};

export const deliberatelySkippedMutation = () => {
  // audit: skip - scheduler reconciliation has its own durable event
  // expect-clean: require-audit-on-mutation/require-audit-on-mutation
  tx.update({ id: "fifteen" });
};

export const readOnlyExecute = () => {
  // expect-clean: require-audit-on-mutation/require-audit-on-mutation
  tx.execute(sql`SELECT 1 FROM items FOR UPDATE`);
};

export const mapDelete = (entries: Map<string, number>) => {
  // expect-clean: require-audit-on-mutation/require-audit-on-mutation
  entries.delete("key");
};
