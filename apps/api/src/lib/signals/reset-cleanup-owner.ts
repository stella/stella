import { panic } from "better-result";
import { and, asc, eq, getTableName, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import {
  assertCallerOrg,
  proveOrgScope,
  withOrgScope,
} from "@/api/db/org-scope";
import type { ORG_SCOPE_TABLES } from "@/api/db/org-scope-registry";
import type { Transaction } from "@/api/db/root";
import { scoutRuns, signalEvents, signals } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import { LIMITS } from "@/api/lib/limits";
import type { SYSTEM_RUN_ACTOR_COUNTS } from "@/api/lib/system-audit/actors";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

const SIGNAL_RESET_TABLES = {
  scoutRuns: { table: scoutRuns, source: "scoutRuns" },
  signalEvents: { table: signalEvents, source: "signalEvents" },
  signalsRemoved: { table: signals, source: "signals" },
} as const satisfies Record<
  (typeof SYSTEM_RUN_ACTOR_COUNTS)["system:review-reset-signal-cleanup"][number],
  { table: PgTable; source: keyof typeof ORG_SCOPE_TABLES }
>;
export const SIGNAL_RESET_AUDITED_TABLES = Object.values(
  SIGNAL_RESET_TABLES,
).map(({ table }) => getTableName(table));

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
  const { table, source } = SIGNAL_RESET_TABLES[tableName];
  let cursor: string | undefined;
  let count = 0;
  for (;;) {
    const page = await readCursorPage(
      tx
        .select({
          id: table.id,
          signalId:
            tableName === "signalEvents"
              ? signalEvents.signalId
              : sql<null>`NULL::uuid`,
        })
        .from(table)
        .where(
          and(
            eq(table.organizationId, organizationId),
            cursor === undefined ? undefined : sql`${table.id} > ${cursor}`,
          ),
        )
        .orderBy(asc(table.id)),
      { limit: LIMITS.signalsPageSizeMax, cursorForItem: (row) => row.id },
    );
    for (const row of page.items) {
      if (source === "signalEvents" && row.signalId === null) {
        panic("Signal event cleanup requires its source signal");
      }
      const parentIdentity =
        row.signalId === null
          ? undefined
          : eq(signalEvents.signalId, row.signalId);
      const parentProof =
        row.signalId === null
          ? undefined
          : // db-await-in-loop: signal events pin their parent before the event source.
            await proveOrgScope(tx, {
              table: "signals",
              where: sql`${and(
                eq(signals.id, row.signalId),
                eq(signals.organizationId, organizationId),
              )}`,
            });
      const parent = parentProof?.unwrapOr(null);
      if (parent === null) {
        continue;
      }
      // db-await-in-loop: prove each source row before lending organization authority.
      const proof = await proveOrgScope(tx, {
        table: source,
        where: sql`${and(
          eq(table.id, row.id),
          eq(table.organizationId, organizationId),
          parentIdentity,
        )}`,
      });
      const scope = proof.unwrapOr(null);
      if (scope === null || assertCallerOrg(scope, organizationId).isErr()) {
        continue;
      }
      const deleteScope = parent ?? scope;
      if (assertCallerOrg(deleteScope, organizationId).isErr()) {
        continue;
      }
      // db-await-in-loop: scoped role settings must be restored before the next row.
      count += await withOrgScope({
        tx,
        scope: deleteScope,
        actor: { type: "system" },
        fn: async (scopedTx) => {
          const changed = await scopedTx
            .delete(table)
            .where(
              and(
                eq(table.id, row.id),
                eq(table.organizationId, deleteScope.organizationId),
                parentIdentity,
              ),
            )
            .returning({ id: table.id });
          return changed.length;
        },
      });
    }
    const last = page.items.at(-1);
    if (page.nextCursor === null || last === undefined) {
      break;
    }
    cursor = last.id;
  }
  await recordSystemAudit(tx, "system:review-reset-signal-cleanup", {
    subject,
    counts: {
      scoutRuns: tableName === "scoutRuns" ? count : 0,
      signalEvents: tableName === "signalEvents" ? count : 0,
      signalsRemoved: tableName === "signalsRemoved" ? count : 0,
    },
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
