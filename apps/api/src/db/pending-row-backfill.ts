/**
 * An online repair that writes the rows of one table a migration left
 * pending, in governed batches. The pending rows are the checkpoint: a
 * committed batch is never selected again, an interrupted pass resumes where
 * it stopped, and a pass over a table with none left changes nothing.
 */

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import type { Verdict } from "@stll/db-load-gate/health";

import { loadGateHealthConfig } from "../env-online-index";
import { createBackfillRuntime } from "./backfill-runtime";
import type {
  OnlineMigrationConnection,
  OnlineRepair,
  OnlineRepairCompletion,
} from "./online-migration-connection";

export type PendingRowBackfillOptions = {
  readVerdict?: () => Promise<Verdict>;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  log?: (record: unknown) => void;
  /** Rows or groups per batch; the runtime may shrink it under load. */
  batchSize?: number;
};

type PendingRowBatch = (options: {
  tx: Pick<OnlineMigrationConnection, "execute" | "query">;
  /** At most this many, never above the repair's own batch size. */
  size: number;
  cursor: string | null;
}) => Promise<{ cursor: string | null; done: boolean; value: number }>;

type PendingRowBackfill = {
  name: string;
  introducedBy: string;
  tableName: string;
  /** A predicate over `tableName` that holds for a row still to write. */
  pending: string;
  /** What the pending rows wait for, as the phase reports it. */
  reason: string;
  batchSize: number;
  batch: PendingRowBatch;
};

export const createPendingRowBackfill = (
  {
    name,
    introducedBy,
    tableName,
    pending,
    reason,
    batchSize,
    batch,
  }: PendingRowBackfill,
  { readVerdict, sleep = Bun.sleep, clock, log }: PendingRowBackfillOptions,
) =>
  ({
    name,
    introducedBy,
    readCompletion: async (connection): Promise<OnlineRepairCompletion> => {
      const left = await connection.query(
        `SELECT 1 FROM public.${tableName} WHERE ${pending} LIMIT 1`,
      );
      if (left.length === 0) {
        return { type: "complete" };
      }
      const checkpoint = await connection.query(
        "SELECT 1 FROM public.database_backfill_states WHERE name = $1",
        [name],
      );
      return checkpoint.length === 0
        ? { type: "incomplete", reason }
        : {
            type: "pending",
            reason,
            cursor: null,
            holdUntil: null,
            heldSince: null,
          };
    },
    repair: async (connection) => {
      const runtime = createBackfillRuntime({
        name,
        tableName,
        initialSize: batchSize,
        config: loadGateHealthConfig(),
        connection,
        readVerdict,
        clock,
        log,
      });
      try {
        const pass = await runBackfillPass({
          holdPolicy: "propagate",
          sleep,
          step: async () =>
            await runtime.step(
              async ({ tx, size, cursor }) =>
                await batch({ tx, size: Math.min(size, batchSize), cursor }),
            ),
        });
        if (pass.isErr()) {
          throw pass.error;
        }
        return { type: "complete" };
      } finally {
        await runtime.close();
      }
    },
  }) satisfies OnlineRepair;
