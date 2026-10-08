import { panic } from "better-result";
import { getTableName, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { Transaction } from "@/api/db/root";
import { scoutRuns, signalEvents, signals } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { SYSTEM_RUN_ACTOR_COUNTS } from "@/api/lib/system-audit/actors";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const SIGNAL_RESET_TABLES = {
  scoutRuns,
  signalEvents,
  signalsRemoved: signals,
} as const satisfies Record<
  (typeof SYSTEM_RUN_ACTOR_COUNTS)["system:review-reset-signal-cleanup"][number],
  PgTable
>;
export const SIGNAL_RESET_AUDITED_TABLES =
  Object.values(SIGNAL_RESET_TABLES).map(getTableName);

export type ResetSignalCleanupOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  subject: SafeId<"schedulerJobRun">;
};

type CleanupSignalTableOptions = ResetSignalCleanupOptions & {
  tableName: keyof typeof SIGNAL_RESET_TABLES;
};

const cleanupSignalTable = async ({
  tx,
  organizationId,
  subject,
  tableName,
}: CleanupSignalTableOptions): Promise<void> => {
  const table = SIGNAL_RESET_TABLES[tableName];
  const row = executedRows(
    await tx.execute(sql`
    WITH removed AS (DELETE FROM ${table}
      WHERE ${table.organizationId} = ${organizationId} RETURNING 1)
    SELECT count(*)::int AS n FROM removed
  `),
  ).at(0);
  if (
    typeof row !== "object" ||
    row === null ||
    !("n" in row) ||
    typeof row.n !== "number" ||
    !Number.isSafeInteger(row.n) ||
    row.n < 0
  ) {
    panic("Signal cleanup must return its non-negative deletion count");
  }
  const counts = {
    scoutRuns: tableName === "scoutRuns" ? row.n : 0,
    signalEvents: tableName === "signalEvents" ? row.n : 0,
    signalsRemoved: tableName === "signalsRemoved" ? row.n : 0,
  };
  await recordSystemAudit(tx, "system:review-reset-signal-cleanup", {
    subject,
    counts,
  });
};

export const cleanupScoutRuns = async (
  options: ResetSignalCleanupOptions,
): Promise<void> => {
  await cleanupSignalTable({ ...options, tableName: "scoutRuns" });
};
export const cleanupSignalEvents = async (
  options: ResetSignalCleanupOptions,
): Promise<void> => {
  await cleanupSignalTable({ ...options, tableName: "signalEvents" });
};
export const cleanupSignals = async (
  options: ResetSignalCleanupOptions,
): Promise<void> => {
  await cleanupSignalTable({ ...options, tableName: "signalsRemoved" });
};
