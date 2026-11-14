/**
 * Claims written before claims carried dates get the date their words
 * assert, read by the same deterministic reader the engine uses
 * (`claimAssertedDate`, without the grader, which only a grading run asks).
 *
 * Only `pending` rows are read and only their three asserted-date columns
 * are written, guarded by `asserted_on_source = 'pending'`: a committed batch
 * is never selected again, a re-run changes nothing, and no other column of
 * a claim is touched. The pending rows are the checkpoint, so an interrupted
 * pass resumes where it stopped. Until a claim is read here, the run reader
 * reads its words the same way (`read-run.ts`), so nothing waits on it.
 */

import { panic } from "better-result";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import type { Verdict } from "@stll/db-load-gate/health";

import {
  assertedDateColumns,
  claimAssertedDate,
} from "@/api/lib/lists/verification/claim-date";
import { isRecord } from "@/api/lib/type-guards";

import { loadGateHealthConfig } from "../env-online-index";
import { createBackfillRuntime } from "./backfill-runtime";
import type {
  OnlineMigrationConnection,
  OnlineMigrationParam,
  OnlineRepair,
  OnlineRepairCompletion,
} from "./online-migration-connection";

const REPAIR_NAME = "list-claim-asserted-dates";
const BATCH = 500;
const PENDING = "asserted_on_source = 'pending'";

type PendingClaim = { id: string; text: string };

const decodePendingClaim = (row: unknown): PendingClaim =>
  isRecord(row) &&
  typeof row["id"] === "string" &&
  typeof row["text"] === "string"
    ? { id: row["id"], text: row["text"] }
    : panic("Invalid pending claim row");

const readCompletion = async (
  connection: OnlineMigrationConnection,
): Promise<OnlineRepairCompletion> => {
  const pending = await connection.query(
    `SELECT 1 FROM public.legal_list_claims WHERE ${PENDING} LIMIT 1`,
  );
  if (pending.length === 0) {
    return { type: "complete" };
  }
  const reason = "claims written before asserted dates await their date";
  const checkpoint = await connection.query(
    "SELECT 1 FROM public.database_backfill_states WHERE name = $1",
    [REPAIR_NAME],
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
};

type BackfillOptions = {
  readVerdict?: () => Promise<Verdict>;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  log?: (record: unknown) => void;
  /** Rows per batch; the runtime may shrink it under load. */
  batchSize?: number;
};

export const createListClaimAssertedDateBackfill = ({
  readVerdict,
  sleep = Bun.sleep,
  clock,
  log,
  batchSize = BATCH,
}: BackfillOptions = {}) =>
  ({
    name: REPAIR_NAME,
    introducedBy: "20261112134328_legal_list_claim_asserted_dates",
    readCompletion,
    repair: async (connection) => {
      const runtime = createBackfillRuntime({
        name: REPAIR_NAME,
        tableName: "legal_list_claims",
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
            await runtime.step(async ({ tx, size, cursor }) => {
              const after = cursor === null ? "" : "AND id > $2::uuid";
              const rows = (
                await tx.query(
                  `SELECT id, text FROM public.legal_list_claims
                    WHERE ${PENDING} ${after}
                    ORDER BY id
                    LIMIT $1`,
                  cursor === null
                    ? [Math.min(size, batchSize)]
                    : [Math.min(size, batchSize), cursor],
                )
              ).map(decodePendingClaim);
              const last = rows.at(-1);
              if (last === undefined) {
                return { cursor: null, done: true, value: 0 };
              }
              // One JSON parameter keeps the statement text the same for
              // every batch size.
              const parameters: OnlineMigrationParam[] = [
                JSON.stringify(
                  rows.map(({ id, text }) => {
                    const columns = assertedDateColumns(
                      claimAssertedDate(text, null),
                    );
                    return {
                      id,
                      asserted_on: columns.assertedOn,
                      asserted_on_precision: columns.assertedOnPrecision,
                      asserted_on_source: columns.assertedOnSource,
                    };
                  }),
                ),
              ];
              await tx.query(
                `UPDATE public.legal_list_claims AS claim
                    SET asserted_on = read.asserted_on,
                        asserted_on_precision = read.asserted_on_precision,
                        asserted_on_source = read.asserted_on_source
                   FROM jsonb_to_recordset($1::text::jsonb)
                     AS read(id uuid, asserted_on date, asserted_on_precision text, asserted_on_source text)
                  WHERE claim.id = read.id
                    AND claim.${PENDING}`,
                parameters,
              );
              return { cursor: last.id, done: false, value: rows.length };
            }),
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

export const LIST_CLAIM_ASSERTED_DATE_BACKFILL =
  createListClaimAssertedDateBackfill();
