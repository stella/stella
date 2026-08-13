// Passive regression fixture for no-untyped-updates.

import type { Transaction } from "@/api/db/root";
import { clauses, ENTITY_KINDS } from "@/api/db/schema";

declare const table: unknown;
declare const db: Transaction;
type InferredTransaction = {
  update: (target: unknown) => {
    set: (value: unknown) => unknown;
  };
};
declare const withTransaction: (
  operation: (tx: InferredTransaction) => unknown,
) => unknown;

export const untypedUpdate = () => {
  const updates: Record<string, unknown> = { title: "Matter" };
  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- fixture: broad records at Drizzle update sinks bypass column checking
  return db.update(table).set(updates);
};

export const aliasedAnyUpdate = () => {
  // oxlint-disable-next-line typescript/no-explicit-any -- fixture: the custom rule must recognize any-valued update bags
  const updates: Record<string, any> = { title: "Matter" };
  const alias = updates;
  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- fixture: a stable alias must not launder a broad update bag
  return db.update(table).set(alias);
};

export const spreadUnknownUpdate = () => {
  const updates: Record<string, unknown> = { title: "Matter" };
  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- fixture: spreading a broad update bag into the sink remains unsafe
  return db.update(table).set({ ...updates, updatedAt: new Date(0) });
};

type BroadUpdateAlias = Record<string, unknown>;

export const aliasedTypeUpdate = () => {
  const updates: BroadUpdateAlias = { title: "Matter" };
  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- fixture: a local type alias must not hide a broad update bag
  return db.update(table).set(updates);
};

export const parameterUpdate = (updates: Record<string, unknown>) =>
  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- fixture: a parameter annotation must retain broad update-bag provenance
  db.update(table).set(updates);

type DestructuredUpdateArgs = {
  metadata: string;
  updates: BroadUpdateAlias;
};

export const destructuredParameterUpdate = ({
  updates,
}: DestructuredUpdateArgs) =>
  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- fixture: destructuring a broad parameter property must retain its annotated provenance
  db.update(table).set(updates);

export const nullableBroadUpdate = (
  updates: Record<string, unknown> | null,
) => {
  if (updates === null) {
    return null;
  }
  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- fixture: narrowing a nullable union must not erase its broad update-bag provenance
  return db.update(table).set(updates);
};

type AuditedBroadUpdate = Record<string, unknown> & {
  auditId: string;
};

export const intersectedBroadUpdate = (updates: AuditedBroadUpdate) =>
  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- fixture: intersecting an explicit field must not close an open update bag
  db.update(table).set(updates);

const loadBroadUpdate = (): Record<string, unknown> => ({ title: "Matter" });

export const functionReturnUpdate = () =>
  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- fixture: a typed local helper return must retain broad update-bag provenance
  db.update(table).set(loadBroadUpdate());

export const inferredTransactionUpdate = (updates: Record<string, unknown>) =>
  withTransaction((tx) =>
    // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- fixture: an imported Drizzle table establishes the sink when a callback transaction is inferred
    tx.update(clauses).set(updates),
  );

// Allowed: broad records used as metadata never reach a Drizzle update sink.
export const metadata: Record<string, unknown> = { source: "court" };

// Allowed: a Map set call is not a Drizzle update sink.
export const cacheMetadata = () =>
  new Map<string, unknown>().set("metadata", metadata);

declare const cache: {
  update: (key: unknown) => { set: (value: unknown) => unknown };
};

// Allowed: fluent method names alone do not establish a Drizzle update sink.
export const updateCacheMetadata = () => cache.update("metadata").set(metadata);

// Allowed: importing a non-table schema value does not turn a typed cache into
// a Drizzle update receiver.
export const updateCacheFromSchemaConstant = () =>
  cache.update(ENTITY_KINDS).set(metadata);

type MatterUpdate = Partial<{ title: string; status: string }>;
const typedUpdate: MatterUpdate = { title: "Matter" };
const loadTypedUpdate = (): MatterUpdate => typedUpdate;

export const destructuredTypedParameterUpdate = ({
  updates,
}: {
  updates: MatterUpdate;
}) => db.update(table).set(updates);

// Allowed: the update bag retains its schema-derived field set.
export const updateMatter = () => db.update(table).set(typedUpdate);

// Allowed: a typed helper return retains its closed field set.
export const updateMatterFromHelper = () =>
  db.update(table).set(loadTypedUpdate());
