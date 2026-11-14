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

import {
  assertedDateColumns,
  claimAssertedDate,
} from "@/api/lib/lists/verification/claim-date";
import { isRecord } from "@/api/lib/type-guards";

import type { OnlineMigrationParam } from "./online-migration-connection";
import {
  createPendingRowBackfill,
  type PendingRowBackfillOptions,
} from "./pending-row-backfill";

const BATCH = 500;
const PENDING = "asserted_on_source = 'pending'";

type PendingClaim = { id: string; text: string };

const decodePendingClaim = (row: unknown): PendingClaim =>
  isRecord(row) &&
  typeof row["id"] === "string" &&
  typeof row["text"] === "string"
    ? { id: row["id"], text: row["text"] }
    : panic("Invalid pending claim row");

export const createListClaimAssertedDateBackfill = ({
  batchSize = BATCH,
  ...options
}: PendingRowBackfillOptions = {}) =>
  createPendingRowBackfill(
    {
      name: "list-claim-asserted-dates",
      introducedBy: "20261112134328_legal_list_claim_asserted_dates",
      tableName: "legal_list_claims",
      pending: PENDING,
      reason: "claims written before asserted dates await their date",
      batchSize,
      batch: async ({ tx, size, cursor }) => {
        const after = cursor === null ? "" : "AND id > $2::uuid";
        const rows = (
          await tx.query(
            `SELECT id, text FROM public.legal_list_claims
              WHERE ${PENDING} ${after}
              ORDER BY id
              LIMIT $1`,
            cursor === null ? [size] : [size, cursor],
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
      },
    },
    options,
  );

export const LIST_CLAIM_ASSERTED_DATE_BACKFILL =
  createListClaimAssertedDateBackfill();
