import { panic } from "better-result";
import { and, asc, desc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";

import { Temporal } from "@stll/time";

import type { rootDb, Transaction } from "@/api/db/root";
import { accountExports } from "@/api/db/schema";
import {
  ACCOUNT_EXPORT_ACTIVE_STATUSES,
  ACCOUNT_EXPORT_LIMITS,
} from "@/api/lib/account-export/constants";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { lockActiveAccountRow } from "@/api/lib/db/account-row";
import {
  withAggregateRowQuery,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
  type Page,
} from "@/api/lib/pagination";
import { admitAccountExportRequest } from "@/api/lib/rate-limit/account-action-budget";
import type { RateLimitContext } from "@/api/lib/rate-limit/rate-limit";

export type AccountExportRow = typeof accountExports.$inferSelect;
export type AccountExportDb = Pick<typeof rootDb, "transaction">;
export type AccountExportClaim = {
  id: string;
  userId: SafeId<"user">;
  token: string;
  objectKey: string;
  leaseExpiresAt: Date;
};
export type AccountExportStatus =
  | { status: "requested" | "processing" | "failed" | "expired"; id: string }
  | { status: "ready"; id: string; expiresAt: Date };

export const accountExportStatus = (
  row: Pick<AccountExportRow, "id" | "status" | "expiresAt">,
): AccountExportStatus => {
  switch (row.status) {
    case "ready":
      if (row.expiresAt === null) {
        panic("Ready account export requires expiry");
      }
      if (row.expiresAt.getTime() <= Temporal.Now.instant().epochMilliseconds) {
        return { status: "expired", id: row.id };
      }
      return { status: "ready", id: row.id, expiresAt: row.expiresAt };
    case "requested":
    case "processing":
    case "failed":
    case "expired":
      return { status: row.status, id: row.id };
    default: {
      row.status satisfies never;
      return panic("Unknown account export status");
    }
  }
};

// Account scope precedes any organization selection; workers reconcile the
// durable ledger across accounts through this owning module only.
const resolveDatabase = async (db: AccountExportDb | undefined) => {
  if (db !== undefined) {
    return db;
  }
  const { rlsDb } = await import("@/api/db/root");
  return rlsDb;
};

const scopeAccount = async (tx: Transaction, userId: SafeId<"user">) => {
  await tx.execute(sql`SET LOCAL ROLE stella`);
  await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
};

const claimable = () =>
  or(
    eq(accountExports.status, "requested"),
    and(
      eq(accountExports.status, "processing"),
      lte(accountExports.leaseExpiresAt, sql`clock_timestamp()`),
    ),
  );
const claimPredicate = (claim: AccountExportClaim) =>
  and(
    eq(accountExports.id, claim.id),
    eq(accountExports.userId, claim.userId),
    eq(accountExports.status, "processing"),
    eq(accountExports.claimToken, claim.token),
    eq(accountExports.objectKey, claim.objectKey),
    gt(accountExports.leaseExpiresAt, sql`clock_timestamp()`),
  );

type RequestAccountExportOptions = {
  db?: AccountExportDb;
  rateLimitContext?: Pick<RateLimitContext, "increment" | "complete">;
};
export const requestAccountExport = async (
  userId: SafeId<"user">,
  { db, rateLimitContext }: RequestAccountExportOptions = {},
): Promise<AccountExportRow> => {
  await admitAccountExportRequest({
    userId,
    max: ACCOUNT_EXPORT_LIMITS.requestsPerWindow,
    durationMs: ACCOUNT_EXPORT_LIMITS.requestWindowMs,
    ...(rateLimitContext === undefined ? {} : { context: rateLimitContext }),
  });
  const database = await resolveDatabase(db);
  return await withAggregateTransaction(database, async (tx) => {
    await lockActiveAccountRow(tx, userId);
    await scopeAccount(tx, userId);
    // Expiration participates in the same lock and transaction as creation.
    const expired = await tx
      .update(accountExports)
      .set({
        status: "expired",
        claimToken: null,
        leaseExpiresAt: null,
        objectKey: null,
        expiresAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(accountExports.userId, userId),
          eq(accountExports.status, "ready"),
          lte(accountExports.expiresAt, sql`clock_timestamp()`),
        ),
      )
      .returning();
    const record = createBackgroundAuditRecorder({ account: { userId } });
    await record(
      tx,
      expired.map(({ id }) => ({
        type: "account.data_export.expired",
        resourceId: id,
      })),
    );
    const existing = await tx
      .select()
      .from(accountExports)
      .where(
        and(
          eq(accountExports.userId, userId),
          inArray(accountExports.status, ACCOUNT_EXPORT_ACTIVE_STATUSES),
        ),
      )
      .limit(1);
    const active = existing.at(0);
    if (active !== undefined) {
      return active;
    }
    const rows = await tx
      .insert(accountExports)
      .values({ id: Bun.randomUUIDv7(), userId })
      .returning();
    const created = rows.at(0);
    if (created === undefined) {
      panic("Account export insertion returned no row");
    }
    await record(tx, {
      type: "account.data_export.requested",
      resourceId: created.id,
    });
    return created;
  });
};

type ReadScopedAccountExportOptions = {
  tx: Transaction;
  id: string;
  userId: SafeId<"user">;
};
const readScopedAccountExport = async ({
  tx,
  id,
  userId,
}: ReadScopedAccountExportOptions): Promise<AccountExportRow | null> => {
  const rows = await tx
    .select()
    .from(accountExports)
    .where(and(eq(accountExports.id, id), eq(accountExports.userId, userId)))
    .limit(1);
  return rows.at(0) ?? null;
};

type ReadAccountExportOptions = {
  id: string;
  userId: SafeId<"user">;
  db?: AccountExportDb;
};
export const readAccountExport = async ({
  id,
  userId,
  db,
}: ReadAccountExportOptions): Promise<AccountExportRow | null> => {
  const database = await resolveDatabase(db);
  return await withAggregateTransaction(database, async (tx) => {
    await scopeAccount(tx, userId);
    return await readScopedAccountExport({ tx, id, userId });
  });
};

export const readLatestAccountExport = async (
  userId: SafeId<"user">,
  db?: AccountExportDb,
): Promise<AccountExportRow | null> => {
  const database = await resolveDatabase(db);
  return await withAggregateTransaction(database, async (tx) => {
    await scopeAccount(tx, userId);
    const rows = await tx
      .select({ id: accountExports.id })
      .from(accountExports)
      .where(eq(accountExports.userId, userId))
      .orderBy(desc(accountExports.createdAt), desc(accountExports.id))
      .limit(1);
    const latest = rows.at(0);
    return latest === undefined
      ? null
      : await readScopedAccountExport({ tx, id: latest.id, userId });
  });
};

export const claimAccountExport = async (
  id: string,
  db: AccountExportDb,
): Promise<AccountExportClaim | null> =>
  await withAggregateTransaction(db, async (tx) => {
    // audit: skip - Lease claims and retry exhaustion maintain the existing request's derived execution state.
    const rows = await tx
      .select()
      .from(accountExports)
      .where(eq(accountExports.id, id))
      .limit(1);
    const row = rows.at(0);
    if (row === undefined) {
      return null;
    }
    await lockActiveAccountRow(tx, row.userId);
    // A crashed final attempt becomes terminal before another worker can claim.
    await tx
      .update(accountExports)
      .set({
        status: "failed",
        claimToken: null,
        leaseExpiresAt: null,
        objectKey: null,
        expiresAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(accountExports.id, id),
          claimable(),
          sql`${accountExports.attemptCount} >= ${ACCOUNT_EXPORT_LIMITS.attempts}`,
        ),
      );
    const token = Bun.randomUUIDv7();
    const objectKey = `account-exports/${row.userId}/${id}/${token}.zip`;
    const claimed = await tx
      .update(accountExports)
      .set({
        status: "processing",
        claimToken: token,
        leaseExpiresAt: sql`clock_timestamp() + (${ACCOUNT_EXPORT_LIMITS.leaseMs} * INTERVAL '1 millisecond')`,
        objectKey,
        attemptCount: sql`${accountExports.attemptCount} + 1`,
        attemptObjectKeys: sql`${accountExports.attemptObjectKeys} || jsonb_build_array(${objectKey}::text)`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(accountExports.id, id),
          claimable(),
          sql`${accountExports.attemptCount} < ${ACCOUNT_EXPORT_LIMITS.attempts}`,
        ),
      )
      .returning({ leaseExpiresAt: accountExports.leaseExpiresAt });
    const claimedRow = claimed.at(0);
    if (claimedRow === undefined) {
      return null;
    }
    if (claimedRow.leaseExpiresAt === null) {
      panic("Claimed export requires a lease deadline");
    }
    return {
      id,
      userId: row.userId,
      token,
      objectKey,
      leaseExpiresAt: claimedRow.leaseExpiresAt,
    };
  });

type CompleteAccountExportOptions = {
  claim: AccountExportClaim;
  objectKey: string;
  db: AccountExportDb;
};
export const completeAccountExport = async ({
  claim,
  objectKey,
  db,
}: CompleteAccountExportOptions): Promise<boolean> => {
  if (objectKey !== claim.objectKey) {
    panic("Account export object differs from its claim");
  }
  return await withAggregateTransaction(db, async (tx) => {
    await lockActiveAccountRow(tx, claim.userId);
    const rows = await tx
      .update(accountExports)
      .set({
        status: "ready",
        claimToken: null,
        leaseExpiresAt: null,
        expiresAt: sql`clock_timestamp() + (${ACCOUNT_EXPORT_LIMITS.ttlMs} * INTERVAL '1 millisecond')`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(claimPredicate(claim))
      .returning({ id: accountExports.id });
    if (rows.length === 0) {
      return false;
    }
    await createBackgroundAuditRecorder({ account: { userId: claim.userId } })(
      tx,
      { type: "account.data_export.ready", resourceId: claim.id },
    );
    return true;
  });
};

export const failAccountExport = async (
  claim: AccountExportClaim,
  db: AccountExportDb,
): Promise<boolean> =>
  await withAggregateTransaction(db, async (tx) => {
    // audit: skip - Retry transitions maintain the existing request's derived execution state.
    const rows = await tx
      .update(accountExports)
      .set({
        status: sql`CASE WHEN ${accountExports.attemptCount} >= ${ACCOUNT_EXPORT_LIMITS.attempts} THEN 'failed' ELSE 'requested' END`,
        claimToken: null,
        leaseExpiresAt: null,
        objectKey: null,
        expiresAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(claimPredicate(claim))
      .returning({ id: accountExports.id });
    return rows.length > 0;
  });

export const expireAccountExport = async (
  id: string,
  db: AccountExportDb,
): Promise<AccountExportRow | null> =>
  await withAggregateTransaction(db, async (tx) => {
    const rows = await tx
      .update(accountExports)
      .set({
        status: "expired",
        claimToken: null,
        leaseExpiresAt: null,
        objectKey: null,
        expiresAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(accountExports.id, id),
          eq(accountExports.status, "ready"),
          lte(accountExports.expiresAt, sql`clock_timestamp()`),
        ),
      )
      .returning();
    const row = rows.at(0);
    if (row === undefined) {
      return null;
    }
    await createBackgroundAuditRecorder({ account: { userId: row.userId } })(
      tx,
      { type: "account.data_export.expired", resourceId: id },
    );
    return row;
  });

const artifactCleanupEligible = () =>
  and(
    inArray(accountExports.status, ["failed", "expired"]),
    sql`${accountExports.updatedAt} + (${ACCOUNT_EXPORT_LIMITS.leaseMs + ACCOUNT_EXPORT_LIMITS.publicationCancellationMarginMs} * INTERVAL '1 millisecond') <= clock_timestamp()`,
  );

export const canReclaimAccountExportObjects = async (
  id: string,
  db: AccountExportDb,
): Promise<boolean> =>
  await withAggregateTransaction(db, async (tx) => {
    const rows = await tx
      .select({ id: accountExports.id })
      .from(accountExports)
      .where(and(eq(accountExports.id, id), artifactCleanupEligible()))
      .limit(1);
    return rows.length > 0;
  });

export const clearAccountExportObjects = async (
  id: string,
  db: AccountExportDb,
): Promise<void> => {
  await withAggregateTransaction(db, async (tx) => {
    // audit: skip - Artifact reclamation clears derived storage references after lifecycle expiry or failure.
    await tx
      .update(accountExports)
      .set({ attemptObjectKeys: [], updatedAt: sql`clock_timestamp()` })
      .where(and(eq(accountExports.id, id), artifactCleanupEligible()));
  });
};

/** Attempt keys are never reused after a claim is revoked. A worker may
 * reclaim its own upload only once the durable winner no longer names it. */
export const canReclaimAccountExportAttempt = async (
  claim: AccountExportClaim,
  db: AccountExportDb,
): Promise<boolean> =>
  await withAggregateTransaction(db, async (tx) => {
    const rows = await tx
      .select({
        status: accountExports.status,
        objectKey: accountExports.objectKey,
      })
      .from(accountExports)
      .where(
        and(
          eq(accountExports.id, claim.id),
          eq(accountExports.userId, claim.userId),
        ),
      )
      .limit(1);
    const row = rows.at(0);
    return (
      row === undefined ||
      row.objectKey !== claim.objectKey ||
      (row.status !== "processing" && row.status !== "ready")
    );
  });

export const recordAccountExportDownload = async ({
  id,
  userId,
  db,
}: ReadAccountExportOptions): Promise<AccountExportRow | null> => {
  const database = await resolveDatabase(db);
  return await withAggregateTransaction(database, async (tx) => {
    await lockActiveAccountRow(tx, userId);
    await scopeAccount(tx, userId);
    const result = await withAggregateRowQuery({
      tx,
      aggregate: "accountExport",
      id: { id, userId },
      mode: "share",
      select: (lockedTx) => lockedTx.select().from(accountExports),
      where: and(
        eq(accountExports.status, "ready"),
        gt(accountExports.expiresAt, sql`clock_timestamp()`),
      ),
    });
    if (result.status === "busy") {
      panic("Blocking account export lock was busy");
    }
    const row = result.rows.at(0);
    if (row === undefined) {
      return null;
    }
    await createBackgroundAuditRecorder({ account: { userId } })(tx, {
      type: "account.data_export.downloaded",
      resourceId: id,
    });
    return row;
  });
};

export const listRecoverableAccountExports = async (
  db: AccountExportDb,
  cursor?: string | null,
): Promise<Page<AccountExportRow>> => {
  const parts = cursor ? decodePaginationCursor(cursor) : null;
  const afterId = parts?.at(0);
  if (cursor && (parts?.length !== 1 || !isUuidPaginationCursorPart(afterId))) {
    throw new HandlerError({
      status: 400,
      code: "account_export_cursor_invalid",
      message: "Invalid cursor.",
    });
  }
  return await withAggregateTransaction(db, async (tx) => {
    const rows = await tx
      .select()
      .from(accountExports)
      .where(
        and(
          or(
            claimable(),
            and(
              eq(accountExports.status, "ready"),
              lte(accountExports.expiresAt, sql`clock_timestamp()`),
            ),
            and(
              artifactCleanupEligible(),
              sql`jsonb_array_length(${accountExports.attemptObjectKeys}) > 0`,
            ),
          ),
          typeof afterId === "string"
            ? gt(accountExports.id, afterId)
            : undefined,
        ),
      )
      .orderBy(asc(accountExports.id))
      .limit(ACCOUNT_EXPORT_LIMITS.recoveryPageSize + 1);
    return createCursorPage({
      rows,
      limit: ACCOUNT_EXPORT_LIMITS.recoveryPageSize,
      cursorForItem: ({ id }) => encodePaginationCursor([id]),
    });
  });
};
