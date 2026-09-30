import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { actionCostCalls, actionCostRecords } from "@/api/db/schema";

import type { ActionCostObservation, ActionCostRecord } from "./context";

export const actionCostWriteQueries = (
  tx: Pick<Transaction, "insert">,
  batch: ActionCostObservation[],
) => {
  const records = new Map<string, ActionCostRecord>();
  const calls = new Map<string, typeof actionCostCalls.$inferInsert>();
  for (const observation of batch) {
    const row = observation.record;
    const key = JSON.stringify([
      row.organizationId,
      row.actionKind,
      row.logicalPhaseId,
    ]);
    switch (observation.type) {
      case "action": {
        const previous = records.get(key);
        const next = observation.record;
        if (previous === undefined) {
          records.set(key, next);
          break;
        }
        let settledAt = previous.settledAt;
        if (
          next.settledAt !== null &&
          (settledAt === null || next.settledAt > settledAt)
        ) {
          settledAt = next.settledAt;
        }
        records.set(key, {
          ...previous,
          admittedAt:
            previous.admittedAt < next.admittedAt
              ? previous.admittedAt
              : next.admittedAt,
          settledAt,
          estimatedMicroUnits:
            previous.estimatedMicroUnits ?? next.estimatedMicroUnits,
        });
        break;
      }
      case "call":
        calls.set(
          JSON.stringify([key, observation.record.callId]),
          observation.record,
        );
        break;
      default:
        observation satisfies never;
        return panic("Unhandled action cost observation");
    }
  }
  const queries = [];
  if (records.size > 0) {
    queries.push(
      tx
        .insert(actionCostRecords)
        .values([...records.values()])
        .onConflictDoUpdate({
          target: [
            actionCostRecords.organizationId,
            actionCostRecords.actionKind,
            actionCostRecords.logicalPhaseId,
          ],
          set: {
            admittedAt: sql`least(${actionCostRecords.admittedAt}, excluded.admitted_at)`,
            settledAt: sql`greatest(${actionCostRecords.settledAt}, excluded.settled_at)`,
            estimatedMicroUnits: sql`coalesce(${actionCostRecords.estimatedMicroUnits}, excluded.estimated_micro_units)`,
          },
        }),
    );
  }
  if (calls.size > 0) {
    queries.push(
      tx
        .insert(actionCostCalls)
        .values([...calls.values()])
        .onConflictDoNothing(),
    );
  }
  return queries;
};

export const writeActionCostObservations = async (
  batch: ActionCostObservation[],
): Promise<void> => {
  // System observations are inaccessible to the tenant role. Resolve the owner
  // connection only when the enabled recorder actually flushes a batch.
  const { rootDb } = await import("@/api/db/root");
  await rootDb.transaction(async (tx) => {
    const queries = actionCostWriteQueries(tx, batch);
    await queries.at(0);
    await queries.at(1);
  });
};
