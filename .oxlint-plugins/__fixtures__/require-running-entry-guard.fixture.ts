import { Result } from "better-result";
import { sql } from "drizzle-orm";

import { timeEntries } from "@/api/db/schema";
import { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";
import type { SafeId } from "@/api/lib/branded-types";

declare const tx: Parameters<typeof guardRunningTimeEntries>[0]["tx"];
declare const options: Parameters<typeof guardRunningTimeEntries>[0];

export const missing = () => {
  // oxlint-disable-next-line require-running-entry-guard/require-running-entry-guard -- fixture: missing running-entry guard
  tx.update(timeEntries);
};

export const guarded = async () => {
  const error = await guardRunningTimeEntries({ ...options, tx });
  if (error) {
    return error;
  }
  // expect-clean: require-running-entry-guard/require-running-entry-guard
  tx.update(timeEntries);
  return null;
};

export const rawMissing = () => {
  // oxlint-disable-next-line require-running-entry-guard/require-running-entry-guard -- fixture: raw SQL mutation has no guard
  tx.execute(sql`UPDATE time_entries SET narrative = 'changed'`);
};

declare const invoiceOptions: {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  actorUserId: SafeId<"user">;
  selection: { type: "invoice"; invoiceId: SafeId<"invoice"> };
};

export const invoiceGuarded = async () => {
  const invoiceGuard = await guardRunningTimeEntries({ ...invoiceOptions, tx });
  if (invoiceGuard.isErr()) {
    return Result.err(invoiceGuard.error);
  }
  // expect-clean: require-running-entry-guard/require-running-entry-guard
  tx.update(timeEntries);
  return Result.ok(invoiceGuard.value);
};
