import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { lockRowsForWrite } from "@/api/lib/db/aggregate-lock";

declare const tx: Transaction;
declare const workspaceId: SafeId<"workspace">;
declare const ids: SafeId<"timeEntry">[];

const submitted = and(
  eq(timeEntries.workspaceId, workspaceId),
  inArray(timeEntries.id, ids),
  eq(timeEntries.status, BILLING_STATUS.SUBMITTED),
);

export const rederived = async () => {
  await tx
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(submitted)
    .limit(ids.length)
    .for("update");
  // oxlint-disable-next-line require-locked-rows-write/require-locked-rows-write -- fixture: the write repeats a state filter instead of naming the locked rows
  await tx
    .update(timeEntries)
    .set({ status: BILLING_STATUS.APPROVED })
    .where(submitted);
};

export const lockedIds = async () => {
  const rows = await tx
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(submitted)
    .limit(ids.length)
    .for("update");
  const locked = rows.map(({ id }) => id);
  // expect-clean: require-locked-rows-write/require-locked-rows-write
  await tx
    .update(timeEntries)
    .set({ status: BILLING_STATUS.APPROVED })
    .where(inArray(timeEntries.id, locked));
};

export const keyLock = async () => {
  await tx
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.workspaceId, workspaceId),
        inArray(timeEntries.id, ids),
      ),
    )
    .limit(ids.length)
    .for("update");
  // expect-clean: require-locked-rows-write/require-locked-rows-write
  await tx
    .delete(timeEntries)
    .where(
      and(
        eq(timeEntries.workspaceId, workspaceId),
        inArray(timeEntries.id, ids),
        eq(timeEntries.status, BILLING_STATUS.DRAFT),
      ),
    );
};

export const ownerLock = async () => {
  const locked = await lockRowsForWrite({
    table: timeEntries,
    query: tx
      .select({ id: timeEntries.id })
      .from(timeEntries)
      .where(submitted)
      .limit(ids.length),
  });
  // expect-clean: require-locked-rows-write/require-locked-rows-write
  await tx
    .update(timeEntries)
    .set({ status: BILLING_STATUS.APPROVED })
    .where(locked.where());
  // oxlint-disable-next-line require-locked-rows-write/require-locked-rows-write -- fixture: a write after the owner lock that repeats the filter instead of the locked rows
  await tx.delete(timeEntries).where(submitted);
};

export const fence = async () => {
  await tx
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(submitted)
    .limit(ids.length)
    .for("update");
  // oxlint-disable-next-line require-locked-rows-write/require-locked-rows-write -- fixture: a reasoned exemption for a write that must also reach rows added after the lock
  await tx
    .update(timeEntries)
    .set({ status: BILLING_STATUS.DRAFT })
    .where(eq(timeEntries.workspaceId, workspaceId));
};
