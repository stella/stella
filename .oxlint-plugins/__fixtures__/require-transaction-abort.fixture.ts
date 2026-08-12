// Passive regression fixture for require-transaction-abort.

declare const safeDb: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
declare const rootDb: {
  transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
};
declare const abortableTx: <T>(
  handle: typeof safeDb,
  fn: (tx: Tx) => Promise<T>,
) => Promise<T>;
declare const recordAuditEvent: (tx: Tx) => Promise<void>;

type Tx = {
  insert: (value: unknown) => Promise<void>;
  update: (value: unknown) => Promise<void>;
  delete: (value: unknown) => Promise<void>;
  select: (value: unknown) => Promise<{ id: string }[]>;
};

declare class HandlerError extends Error {
  readonly status: number;
  constructor(init: { status: number; message: string });
}

// A rejection raised after a write commits that write.
export const returnsAfterInsert = async () =>
  await safeDb(async (tx) => {
    await tx.insert({ id: "one" });
    // oxlint-disable-next-line require-transaction-abort/require-transaction-abort -- fixture: failure returned after a write
    return { ok: false as const, status: 400 as const, message: "rejected" };
  });

// An audit row is a row: rejecting after one still commits it.
export const returnsAfterAudit = async () =>
  await safeDb(async (tx) => {
    await recordAuditEvent(tx);
    // oxlint-disable-next-line require-transaction-abort/require-transaction-abort -- fixture: failure returned after an audit row
    return { success: false as const, message: "rejected" };
  });

// `.transaction(...)` opens one too.
export const returnsInsideRootTransaction = async () =>
  await rootDb.transaction(async (tx) => {
    await tx.update({ id: "two" });
    // oxlint-disable-next-line require-transaction-abort/require-transaction-abort -- fixture: failure returned from a .transaction callback
    return new HandlerError({ status: 409, message: "rejected" });
  });

// The callback of `abortableTx` is its second argument.
export const returnsInsideAbortableTx = async () =>
  await abortableTx(safeDb, async (tx) => {
    await tx.delete({ id: "three" });
    // oxlint-disable-next-line require-transaction-abort/require-transaction-abort -- fixture: failure returned from an abortableTx callback
    return { ok: false as const, status: 500 as const, message: "rejected" };
  });

// Throwing aborts, which is the whole point of the rule.
export const throwsAfterInsert = async () =>
  await safeDb(async (tx) => {
    await tx.insert({ id: "four" });
    if (Math.random() > 0.5) {
      throw new HandlerError({ status: 400, message: "rejected" });
    }
    return { id: "four" };
  });

// Nothing has been written yet, so the commit carries no partial write.
export const returnsBeforeAnyWrite = async () =>
  await safeDb(async (tx) => {
    const rows = await tx.select({ id: "five" });
    if (rows.length === 0) {
      return { ok: false as const, status: 404 as const, message: "missing" };
    }
    await tx.insert({ id: "five" });
    return { ok: true as const };
  });

// The inner closure's return decides nothing about the transaction: only the
// callback's own return value does.
export const nestedClosureReturnIsNotTheCallback = async () =>
  await safeDb(async (tx) => {
    await tx.insert({ id: "six" });
    const classify = (rows: readonly { id: string }[]) =>
      rows.length === 0 ? { ok: false as const } : { ok: true as const };
    return classify(await tx.select({ id: "six" }));
  });

// A read through the handle is not a write.
export const returnsAfterReadOnly = async () =>
  await safeDb(async (tx) => {
    const rows = await tx.select({ id: "seven" });
    return {
      ok: false as const,
      status: 400 as const,
      message: `${rows.length}`,
    };
  });
