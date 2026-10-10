import { sql } from "drizzle-orm";

import { entities } from "@/api/db/schema";

declare const db: {
  insert: (table: unknown) => unknown;
  update: (table: unknown) => unknown;
  delete: (table: unknown) => unknown;
  select: () => unknown;
  execute: (query: unknown) => unknown;
};
declare const tx: typeof db;
declare const safeDb: (run: (handle: typeof db) => unknown) => unknown;
declare const writeFieldValue: (handle: typeof db, value: string) => unknown;

// Drizzle writes on a database handle.
// oxlint-disable-next-line no-chat-table-write/no-chat-table-write
const _insert = db.insert(entities);
// oxlint-disable-next-line no-chat-table-write/no-chat-table-write
const _update = tx.update(entities);
// oxlint-disable-next-line no-chat-table-write/no-chat-table-write
const _delete = tx.delete(entities);
const _scoped = safeDb(
  // oxlint-disable-next-line no-chat-table-write/no-chat-table-write
  (scopedTx) => scopedTx.insert(entities),
);

// Raw SQL that writes rows.
// oxlint-disable-next-line no-chat-table-write/no-chat-table-write
const _rawUpdate = tx.execute(sql`UPDATE entities SET name = ${"x"}`);

// Reads, read-only SQL and lib write primitives are fine.
// expect-clean: no-chat-table-write/no-chat-table-write
const _select = tx.select();
// expect-clean: no-chat-table-write/no-chat-table-write
const _rawSelect = db.execute(sql`SELECT 1 FROM entities`);
// expect-clean: no-chat-table-write/no-chat-table-write
const _primitive = safeDb((scopedTx) => writeFieldValue(scopedTx, "x"));

export const __noChatTableWriteFixture = {
  _insert,
  _update,
  _delete,
  _scoped,
  _rawUpdate,
  _select,
  _rawSelect,
  _primitive,
};
