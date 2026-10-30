import { panic, Result, TaggedError } from "better-result";
import { type SQL, sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";

import type { SafeId } from "../lib/branded-types";
import { TABLE_LEASE_QUEUE_LOCK_QUERY } from "../lib/db/aggregate-lock";
import { executedRows } from "../lib/db/executed-rows";
import {
  DEFAULT_LEASE_MS,
  DEFAULT_POLL_INTERVAL_MS,
  defaultHeartbeatIntervalMs,
} from "../lib/scheduler/lease-timing";
import type { OnlineMigrationConnection } from "./online-migration-connection";

export const TABLE_LEASE_MIGRATION = "20261030213017_scheduler_table_leases";
const HOLDER_REPORT_LIMIT = 100;
// Completion retains execution identity beyond its last live lease for recent-run checks.
export const SCHEDULER_EXECUTION_EVIDENCE_MS = 10 * 60_000;
const EXPIRED_EXECUTION_PRUNE_LIMIT = 100;
export const MIGRATION_TABLE_LEASE_WAIT_MS =
  DEFAULT_LEASE_MS + defaultHeartbeatIntervalMs(DEFAULT_LEASE_MS);

type TableLeaseExecutor = { execute: (query: SQL) => PromiseLike<unknown> };

/** Claims and exclusive requests linearize before looking at the queue. */
export const tableLeaseClaimLock = async (tx: TableLeaseExecutor) => {
  await tx.execute(sql.raw(TABLE_LEASE_QUEUE_LOCK_QUERY));
};

export const jobTableLeasesAvailable = (tables: readonly string[]) =>
  tables.length === 0
    ? sql`true`
    : sql`NOT EXISTS (
    SELECT 1 FROM scheduler_table_leases
    WHERE (table_name = '*' OR ${
      tables.includes("*")
        ? sql`true`
        : sql`table_name IN (${sql.join(
            tables.map((table) => sql`${table}`),
            sql`, `,
          )})`
    })
      AND mode = 'exclusive' AND expires_at > clock_timestamp()
  )`;

type AcquireJobTableLeasesOptions = {
  tx: TableLeaseExecutor;
  tables: readonly string[];
  holderId: string;
  leaseMs: number;
  execution: { token: string; jobId: string; runId: SafeId<"schedulerJobRun"> };
};

export const acquireJobTableLeases = async ({
  tx,
  tables,
  holderId,
  leaseMs,
  execution,
}: AcquireJobTableLeasesOptions) => {
  if (tables.length === 0) {
    return true;
  }
  await tableLeaseClaimLock(tx);
  const rows = await tx.execute(
    sql`SELECT ${jobTableLeasesAvailable(tables)} AS available`,
  );
  const [{ available }] = v.parse(
    v.tuple([v.object({ available: v.boolean() })]),
    executedRows(rows),
  );
  if (!available) {
    return false;
  }
  await tx.execute(
    sql`DELETE FROM scheduler_table_leases WHERE expires_at <= clock_timestamp()`,
  );
  await tx.execute(sql`INSERT INTO scheduler_table_leases
    (table_name, holder_kind, holder_id, mode, requested_at, granted_at, expires_at)
    SELECT table_name, 'job', ${holderId}, 'shared', clock_timestamp(), clock_timestamp(),
      now() + ${leaseMs}::integer * interval '1 millisecond'
    FROM unnest(ARRAY[${sql.join(
      [...new Set(tables)].toSorted().map((table) => sql`${table}`),
      sql`, `,
    )}]::text[]) AS table_name`);
  await tx.execute(sql`DELETE FROM scheduler_table_lease_activity
    WHERE execution_token IN (SELECT execution_token FROM scheduler_table_lease_activity
      WHERE expires_at <= clock_timestamp() ORDER BY expires_at
      LIMIT ${EXPIRED_EXECUTION_PRUNE_LIMIT})`);
  await tx.execute(sql`INSERT INTO scheduler_table_lease_activity
    (execution_token, holder_id, job_id, run_id, claimed_at, expires_at)
    VALUES (${execution.token}, ${holderId}, ${execution.jobId}, ${execution.runId},
      clock_timestamp(), clock_timestamp() + ${leaseMs + SCHEDULER_EXECUTION_EVIDENCE_MS}::integer * interval '1 millisecond')`);
  return true;
};

export const renewJobTableLeases = async (
  tx: TableLeaseExecutor,
  holderId: string,
  leaseMs: number,
) => {
  const rows = await tx.execute(sql`UPDATE scheduler_table_leases
    SET expires_at = now() + ${leaseMs}::integer * interval '1 millisecond'
    WHERE holder_kind = 'job' AND holder_id = ${holderId} AND expires_at > clock_timestamp() RETURNING table_name`);
  await tx.execute(sql`UPDATE scheduler_table_lease_activity
    SET expires_at = clock_timestamp() + ${leaseMs + SCHEDULER_EXECUTION_EVIDENCE_MS}::integer * interval '1 millisecond'
    WHERE holder_id = ${holderId} AND expires_at > clock_timestamp()`);
  return executedRows(rows).length;
};

export const releaseJobTableLeases = async (
  tx: TableLeaseExecutor,
  holderId: string,
) => {
  await tx.execute(
    sql`DELETE FROM scheduler_table_leases WHERE holder_kind = 'job' AND holder_id = ${holderId}`,
  );
};

/** Coordination bootstraps from its committed migration, including on an empty database. */
export const ensureTableLeaseQueue = async ({
  connection,
  migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url)),
}: {
  connection: OnlineMigrationConnection;
  migrationsFolder?: string;
}) => {
  const [{ exists }] = v.parse(
    v.tuple([v.object({ exists: v.boolean() })]),
    await connection.query(
      "SELECT to_regclass('public.scheduler_table_leases') IS NOT NULL AND to_regclass('public.scheduler_table_lease_activity') IS NOT NULL AS exists",
    ),
  );
  if (exists) {
    return;
  }
  const migration = await readFile(
    path.join(migrationsFolder, TABLE_LEASE_MIGRATION, "migration.sql"),
    "utf-8",
  );
  await connection.execute("BEGIN");
  try {
    await connection.execute(TABLE_LEASE_QUEUE_LOCK_QUERY);
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) {
        await connection.execute(statement);
      }
    }
    await connection.execute("COMMIT");
  } catch (error) {
    await connection.execute("ROLLBACK");
    throw error;
  }
};

export type TableLeaseEvent = {
  event:
    | "migrate.table_lease_requested"
    | "migrate.table_lease_granted"
    | "migrate.table_lease_timed_out"
    | "migrate.table_lease_released";
  tableCount: number;
  holderCount: number;
  oldestHolderAgeMs: number;
  waitMs: number;
};

export class MigrationTableLeaseTimeoutError extends TaggedError(
  "MigrationTableLeaseTimeoutError",
)<{
  message: string;
  holders: readonly { holderId: string; ageMs: number }[];
}> {}

const blockerSchema = v.array(
  v.object({ holderId: v.string(), ageMs: v.number() }),
);
const countsSchema = v.tuple([v.object({ count: v.number() })]);

type AcquireMigrationTableLeasesOptions = {
  connection: OnlineMigrationConnection;
  tables: readonly string[];
  holderId: string;
  onLeaseLost: (cause: unknown) => Promise<void>;
  emit?: (event: TableLeaseEvent) => void;
  waitMs?: number;
  checkEveryMs?: number;
  leaseMs?: number;
};

export const acquireMigrationTableLeases = async ({
  connection,
  tables,
  holderId,
  onLeaseLost,
  emit = (record) => {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  },
  waitMs = MIGRATION_TABLE_LEASE_WAIT_MS,
  checkEveryMs = DEFAULT_POLL_INTERVAL_MS,
  leaseMs = DEFAULT_LEASE_MS,
}: AcquireMigrationTableLeasesOptions) => {
  if (
    ![leaseMs, checkEveryMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    !Number.isSafeInteger(waitMs) ||
    waitMs < 0 ||
    checkEveryMs >= leaseMs
  ) {
    panic("Invalid migration table lease timing");
  }
  const names = [...new Set(tables)].toSorted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewal: Promise<void> | undefined;
  let lost: unknown;
  let state: "waiting" | "held" | "releasing" | "released" = "waiting";
  const startedAt = performance.now();
  let holders: v.InferOutput<typeof blockerSchema> = [];
  const report = (event: TableLeaseEvent["event"]) =>
    emit({
      event,
      tableCount: names.length,
      holderCount: holders.length,
      oldestHolderAgeMs: Math.max(0, ...holders.map(({ ageMs }) => ageMs)),
      waitMs: Math.round(performance.now() - startedAt),
    });
  const assertHeld = async () => {
    if (lost !== undefined) {
      throw lost;
    }
    if (names.length === 0) {
      return;
    }
    const [{ count }] = v.parse(
      countsSchema,
      await connection.query(
        `SELECT count(*)::integer AS count FROM scheduler_table_leases
       WHERE holder_kind = 'migration' AND holder_id = $1
         AND granted_at IS NOT NULL AND expires_at > clock_timestamp()`,
        [holderId],
      ),
    );
    if (count !== names.length) {
      panic("Migration table leases are no longer held");
    }
  };
  const release = async () => {
    if (state === "released") {
      return;
    }
    state = "releasing";
    clearTimeout(timer);
    await renewal;
    if (names.length === 0) {
      state = "released";
      return;
    }
    await connection.execute(
      "DELETE FROM scheduler_table_leases WHERE holder_kind = 'migration' AND holder_id = $1",
      [holderId],
    );
    state = "released";
    report("migrate.table_lease_released");
  };
  if (names.length === 0) {
    state = "held";
    return { release, assertHeld };
  }
  if (names.some((name) => name.includes(","))) {
    panic("Table lease names must not contain commas");
  }
  const renew = async () => {
    const rows = await connection.query(
      `UPDATE scheduler_table_leases SET expires_at = clock_timestamp() + $2::integer * interval '1 millisecond'
       WHERE holder_kind = 'migration' AND holder_id = $1 AND expires_at > clock_timestamp() RETURNING table_name`,
      [holderId, leaseMs],
    );
    if (rows.length !== names.length) {
      panic("Migration table lease renewal lost ownership");
    }
  };
  const scheduleRenewal = () => {
    if (state !== "held") {
      return;
    }
    timer = setTimeout(() => {
      renewal = (async () => {
        const result = await Result.tryPromise(renew);
        if (result.isErr()) {
          lost = result.error;
          const cancellation = await Result.tryPromise(() =>
            onLeaseLost(result.error),
          );
          if (cancellation.isErr()) {
            lost = cancellation.error;
          }
          return;
        }
        scheduleRenewal();
      })();
    }, checkEveryMs);
  };
  await connection.execute("BEGIN");
  try {
    await connection.execute(TABLE_LEASE_QUEUE_LOCK_QUERY);
    await connection.execute(
      "DELETE FROM scheduler_table_leases WHERE expires_at <= clock_timestamp()",
    );
    await connection.execute(
      `INSERT INTO scheduler_table_leases (table_name, holder_kind, holder_id, mode, requested_at, expires_at)
       SELECT name, 'migration', $1, 'exclusive', clock_timestamp(), clock_timestamp() + $3::integer * interval '1 millisecond'
       FROM unnest(string_to_array($2, ',')) AS name`,
      [holderId, names.join(","), leaseMs],
    );
    await connection.execute("COMMIT");
  } catch (error) {
    await connection.execute("ROLLBACK");
    throw error;
  }
  try {
    report("migrate.table_lease_requested");
    const attemptGrant = async (): Promise<void> => {
      await connection.execute("BEGIN");
      try {
        await connection.execute(TABLE_LEASE_QUEUE_LOCK_QUERY);
        await renew();
        holders = v.parse(
          blockerSchema,
          await connection.query(
            `SELECT other.holder_id AS "holderId",
           greatest(0, extract(epoch FROM clock_timestamp() - min(other.requested_at)) * 1000)::float8 AS "ageMs"
         FROM scheduler_table_leases own JOIN scheduler_table_leases other ON (own.table_name = other.table_name OR own.table_name = '*' OR other.table_name = '*')
         WHERE own.holder_kind = 'migration' AND own.holder_id = $1
           AND other.holder_id <> $1 AND other.expires_at > clock_timestamp()
           AND (other.mode = 'shared' OR (other.requested_at, other.holder_id) < (own.requested_at, own.holder_id))
         GROUP BY other.holder_id ORDER BY "ageMs" DESC LIMIT $2`,
            [holderId, HOLDER_REPORT_LIMIT],
          ),
        );
        if (holders.length === 0) {
          await connection.execute(
            "UPDATE scheduler_table_leases SET granted_at = clock_timestamp() WHERE holder_kind = 'migration' AND holder_id = $1",
            [holderId],
          );
          await connection.execute("COMMIT");
          state = "held";
          report("migrate.table_lease_granted");
          return;
        }
        await connection.execute("COMMIT");
      } catch (error) {
        await connection.execute("ROLLBACK");
        throw error;
      }
      const remainingMs = waitMs - (performance.now() - startedAt);
      if (remainingMs <= 0) {
        report("migrate.table_lease_timed_out");
        throw new MigrationTableLeaseTimeoutError({
          message: `Migration table lease wait timed out; holders: ${holders.map(({ holderId: id, ageMs }) => `${id} (${Math.round(ageMs)}ms)`).join(", ")}`,
          holders,
        });
      }
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.min(checkEveryMs, remainingMs));
      });
      return await attemptGrant();
    };
    await attemptGrant();
    scheduleRenewal();
    return { release, assertHeld };
  } catch (error) {
    await release();
    throw error;
  }
};
