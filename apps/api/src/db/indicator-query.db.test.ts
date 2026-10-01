import { Result } from "better-result";
import type { ReservedSQL } from "bun";
import { describe, expect, test } from "bun:test";

import { defaultConfig } from "@stll/db-load-gate/health";
import { longTransaction } from "@stll/db-load-gate/indicators";

import { isPgError, PG_ERROR } from "../lib/pg-error";
import type { IngestionTransactionRunner } from "../lib/replay-safe-ingestion";
import { withGatedTestClients } from "../tests/gated-test-database";
import { createBoundedIndicatorQuery } from "./indicator-query";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const BLOCKED_READ_QUERY = "SELECT pg_advisory_xact_lock($1::bigint)";

describe.skipIf(!enabled)(
  "bounded catalog reads on a reserved database session",
  () => {
    test("logical timeouts cancel every SQL read and leave the batch connection usable with its original budget", async () => {
      if (databaseUrl === undefined) {
        throw new TypeError("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const connection = await openClient().sql.reserve();
        const blocker = await openClient().sql.reserve();
        const lockKey = BigInt(
          `0x${Bun.randomUUIDv7().replaceAll("-", "").slice(0, 15)}`,
        ).toString();
        const runInTransaction: IngestionTransactionRunner<
          ReservedSQL
        > = async (work) => {
          await connection`BEGIN`;
          try {
            return await work(connection);
          } finally {
            await connection`ROLLBACK`;
          }
        };
        let submittedReads = 0;
        const reads = createBoundedIndicatorQuery({
          runInTransaction,
          transactionQuery:
            (tx) =>
            async (statement, parameters = []) => {
              if (statement === BLOCKED_READ_QUERY) {
                submittedReads++;
              }
              return await tx.unsafe<unknown[]>(statement, [...parameters]);
            },
          readTimeoutMs: 100,
        });
        try {
          const held = await blocker<
            { acquired: boolean }[]
          >`SELECT pg_try_advisory_lock(${lockKey}::bigint) AS acquired`;
          expect(held.at(0)?.acquired).toBe(true);
          await connection`SET statement_timeout = '45s'`;
          const cancellations: Promise<boolean>[] = [];
          const read = async () => {
            const cancellation = Result.tryPromise(
              async () => await reads.query(BLOCKED_READ_QUERY, [lockKey]),
            ).then(
              (outcome) =>
                Result.isError(outcome) &&
                isPgError(outcome.error, PG_ERROR.QUERY_CANCELED),
            );
            cancellations.push(cancellation);
            await cancellation;
            return null;
          };
          const config = { ...defaultConfig, readTimeoutMs: 100 };
          // The logical timer expires deterministically before the server query
          // finishes. No elapsed-time assertion or sleep controls this test.
          const timeout = () => ({
            expired: Promise.resolve(),
            cancel: () => undefined,
          });
          const signals = await Promise.all([
            longTransaction({ read, now: () => 0, config, timeout }),
            longTransaction({ read, now: () => 0, config, timeout }),
          ]);
          expect(signals.map(({ kind }) => kind)).toEqual([
            "unknown",
            "unknown",
          ]);
          await reads.settle();
          expect(submittedReads).toBe(2);
          expect(await Promise.all(cancellations)).toEqual([true, true]);
          const settings = await connection<
            { statement_timeout: string }[]
          >`SHOW statement_timeout`;
          expect(settings.at(0)?.statement_timeout).toBe("45s");
          await connection`BEGIN`;
          const rows = await connection<{ ready: number }[]>`SELECT 1 AS ready`;
          expect(rows.at(0)?.ready).toBe(1);
          await connection`ROLLBACK`;
        } finally {
          await connection`ROLLBACK`;
          await blocker`SELECT pg_advisory_unlock(${lockKey}::bigint)`;
          connection.release();
          blocker.release();
        }
      });
    });
  },
);
