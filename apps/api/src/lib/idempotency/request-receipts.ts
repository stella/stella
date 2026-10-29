import { panic, Result } from "better-result";
import {
  and,
  asc,
  eq,
  inArray,
  lt,
  or,
  sql,
  TransactionRollbackError,
} from "drizzle-orm";

import {
  IDEMPOTENCY_IN_PROGRESS_CODE,
  IDEMPOTENCY_KEY_REUSED_CODE,
} from "@stll/api-contract";
import { createSha256, sha256Hex } from "@stll/sha256/bun";
import { stableStringify } from "@stll/stable-stringify";
import { DAY_IN_MS } from "@stll/time";

import type { ScopedDb } from "@/api/db/safe-db";
import { requestIdempotencyReceipts as receipts } from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import {
  setSharedLockTimeout,
  setSharedStatementTimeout,
} from "@/api/db/shared-pool-timeouts";
import { isHttpStatusResponse } from "@/api/http/status";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  withAggregateLock,
  withAggregateSavepoint,
  withSkipLockedBatch,
} from "@/api/lib/db/aggregate-lock";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { transitionScopedCount } from "@/api/lib/db/transitions";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { REQUEST_IDEMPOTENCY_RECEIPT_TRANSITIONS } from "@/api/lib/idempotency/request-receipt-transition-spec";
import { toJsonValue } from "@/api/lib/json-value";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import type { SchedulerDb } from "@/api/lib/scheduler/types";

type FingerprintRequestOptions = {
  method: string;
  route: string;
  body: unknown;
  params: unknown;
  query: unknown;
};

// Canonicalize only after JSON serialization: dates and omitted undefined fields
// must have the same representation as the body that crossed the HTTP boundary.
export const fingerprintRequest = (
  input: FingerprintRequestOptions,
): string => {
  const encoded = JSON.stringify(input);
  const jsonInput: unknown = JSON.parse(encoded);
  return sha256Hex(stableStringify(toJsonValue(jsonInput)));
};

const normalizeHttpFingerprintValue = async (
  value: unknown,
): Promise<unknown> => {
  if (value instanceof Blob) {
    const hash = createSha256();
    for await (const chunk of value.stream()) {
      hash.update(chunk);
    }
    return {
      type: value instanceof File ? "file" : "blob",
      name: value instanceof File ? value.name : null,
      contentType: value.type,
      size: value.size,
      sha256: hash.digest("hex"),
    };
  }
  if (value instanceof Date || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return await Promise.all(value.map(normalizeHttpFingerprintValue));
  }
  return Object.fromEntries(
    await Promise.all(
      Object.entries(value).map(
        async ([key, entry]) =>
          [key, await normalizeHttpFingerprintValue(entry)] as const,
      ),
    ),
  );
};

/** Multipart file identity includes bytes; JSON requests retain the same fingerprint. */
export const fingerprintHttpRequest = async (
  input: FingerprintRequestOptions,
): Promise<string> => {
  const [body, params, query] = await Promise.all([
    normalizeHttpFingerprintValue(input.body),
    normalizeHttpFingerprintValue(input.params),
    normalizeHttpFingerprintValue(input.query),
  ]);
  return fingerprintRequest({
    method: input.method,
    route: input.route,
    body,
    params,
    query,
  });
};

type ClaimRequestReceiptOptions = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  key: string;
  route: string;
  fingerprint: string;
  now?: Date;
};

export type RequestReceiptClaim =
  | { type: "claimed"; id: SafeId<"requestIdempotencyReceipt"> }
  | { type: "replay"; status: number; body: unknown }
  | { type: "in_progress" }
  | { type: "key_reused" }
  | { type: "invalid_key" };

export const claimRequestReceipt = async ({
  scopedDb,
  organizationId,
  userId,
  key,
  route,
  fingerprint,
  now = new Date(),
}: ClaimRequestReceiptOptions): Promise<RequestReceiptClaim> => {
  if (key.length === 0 || key.length > 128) {
    return { type: "invalid_key" };
  }
  return await scopedDb(async (tx) => {
    const match = and(
      eq(receipts.organizationId, organizationId),
      eq(receipts.userId, userId),
      eq(receipts.idempotencyKey, key),
    );
    const visible = (await tx.select().from(receipts).where(match).limit(1)).at(
      0,
    );
    if (!visible) {
      const id = createSafeId<"requestIdempotencyReceipt">();
      // audit: skip - Request coordination; the create handler audits its resource mutation.
      const inserted = await tx
        .insert(receipts)
        .values({
          id,
          organizationId,
          userId,
          idempotencyKey: key,
          route,
          requestFingerprint: fingerprint,
          state: "pending",
          claimedAt: now,
        })
        .onConflictDoNothing({
          target: [
            receipts.organizationId,
            receipts.userId,
            receipts.idempotencyKey,
          ],
        })
        .returning({ id: receipts.id });
      if (inserted.length > 0) {
        return { type: "claimed", id };
      }
    }
    // Never run without observing ownership, even if the conflicting row
    // disappears between insertion and readback.
    const existing =
      visible ?? (await tx.select().from(receipts).where(match).limit(1)).at(0);
    if (!existing) {
      return { type: "in_progress" };
    }
    if (existing.requestFingerprint !== fingerprint) {
      return { type: "key_reused" };
    }
    if (existing.state === "completed") {
      if (existing.responseCode === null) {
        panic("Completed receipt has no response status");
      }
      return {
        type: "replay",
        status: existing.responseCode,
        body: existing.responseBody,
      };
    }
    // An active owner holds this row until its resource and response commit
    // together. Only retention may remove an abandoned, unlocked pending row.
    return { type: "in_progress" };
  });
};

type ReceiptIdentity = {
  scopedDb: ScopedDb;
  id: SafeId<"requestIdempotencyReceipt">;
};

type CompleteRequestReceiptOptions = ReceiptIdentity & {
  status: number;
  body: unknown;
};

export const completeRequestReceipt = async ({
  scopedDb,
  id,
  status,
  body,
}: CompleteRequestReceiptOptions): Promise<void> => {
  await scopedDb(async (tx) => {
    const completed = await transitionScopedCount({
      tx,
      spec: REQUEST_IDEMPOTENCY_RECEIPT_TRANSITIONS,
      where: eq(receipts.id, id),
      options: {
        from: ["pending"],
        to: "completed",
        set: {
          responseCode: status,
          responseBody: body,
          completedAt: new Date(),
        },
      },
      // audit: skip - Completion caches an already audited create response for replay.
      recordTransitionAuditEvent: () => undefined,
    });
    if (completed !== 1) {
      panic("Receipt completion must update its owned pending row");
    }
  });
};

type ReplayRequestOptions<T> = ClaimRequestReceiptOptions & {
  authorize?: () => Promise<Result<void, HandlerError>>;
  run: (scopedDb: ScopedDb) => Promise<T>;
  responseStatus: () => number;
};

// A replay writes the serialized transport response of the original T. Keep
// the handler's inferred payload contract; Response is an implementation detail
// of replaying that same JSON through HTTP, not another payload schema.
export function runWithRequestReceipt<T>(
  options: ReplayRequestOptions<T>,
): Promise<Result<T, HandlerError>>;
export async function runWithRequestReceipt<T>({
  authorize,
  run,
  responseStatus,
  ...options
}: ReplayRequestOptions<T>): Promise<Result<unknown, HandlerError>> {
  if (authorize !== undefined) {
    const authorization = await authorize();
    if (authorization.isErr()) {
      return authorization;
    }
  }
  const claim = await claimRequestReceipt(options);
  switch (claim.type) {
    case "replay":
      return Result.ok(
        new Response(
          claim.status === 204 || claim.status === 205
            ? null
            : JSON.stringify(claim.body),
          {
            status: claim.status,
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Replayed": "true",
            },
          },
        ),
      );
    case "invalid_key":
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Idempotency-Key must contain 1 to 128 characters.",
        }),
      );
    case "in_progress":
      return Result.err(
        new HandlerError({
          status: 409,
          code: IDEMPOTENCY_IN_PROGRESS_CODE,
          message: "This request is still in progress.",
        }),
      );
    case "key_reused":
      return Result.err(
        new HandlerError({
          status: 422,
          code: IDEMPOTENCY_KEY_REUSED_CODE,
          message: "This key was already used for a different request.",
        }),
      );
    case "claimed": {
      let refusal: { response: unknown } | undefined;
      let receiptState: "pending" | "completed" = "pending";
      try {
        const outcome = await Result.tryPromise(
          async () =>
            await options.scopedDb(async (tx) => {
              const lock = await withAggregateLock({
                tx,
                aggregate: "requestReceipt",
                id: {
                  id: claim.id,
                  organizationId: options.organizationId,
                  userId: options.userId,
                },
                mode: "update",
                wait: "nowait",
              });
              switch (lock.status) {
                case "missing":
                case "busy":
                  return Result.err(
                    new HandlerError({
                      status: 409,
                      code: IDEMPOTENCY_IN_PROGRESS_CODE,
                      message: "This request is still in progress.",
                    }),
                  );
                case "locked":
                  break;
                default:
                  lock satisfies never;
                  return panic("Unhandled request receipt lock state");
              }
              // Every handler operation is a savepoint of the receipt-owning
              // transaction. No resource can commit without its replay response.
              const transactionalDb: ScopedDb = async (fn) =>
                await withAggregateSavepoint(tx, fn);
              const result = await run(transactionalDb);
              let body: unknown = result;
              let status = responseStatus();
              while (isHttpStatusResponse(body)) {
                status = body.code;
                body = body.response;
              }
              if (status < 200 || status >= 300) {
                refusal = { response: result };
                return tx.rollback();
              }
              if (
                body instanceof Response ||
                body instanceof ReadableStream ||
                body instanceof Blob ||
                body instanceof ArrayBuffer ||
                ArrayBuffer.isView(body)
              ) {
                panic("Idempotency replay requires a JSON handler");
              }
              await completeRequestReceipt({
                scopedDb: transactionalDb,
                id: claim.id,
                status,
                body,
              });
              return Result.ok(result);
            }),
        );
        if (outcome.isErr()) {
          if (
            refusal !== undefined &&
            outcome.error.cause instanceof TransactionRollbackError
          ) {
            return Result.ok(refusal.response);
          }
          return abortTransaction(outcome.error.cause);
        }
        if (outcome.value.isOk()) {
          receiptState = "completed";
        }
        return outcome.value;
      } finally {
        if (receiptState === "pending") {
          await options.scopedDb(async (tx) => {
            // audit: skip - Rollback leaves no resource; completed receipts remain replayable.
            await tx
              .delete(receipts)
              .where(
                and(eq(receipts.id, claim.id), eq(receipts.state, "pending")),
              );
          });
        }
      }
    }
    default: {
      claim satisfies never;
      return panic("Unhandled request receipt claim state");
    }
  }
}

const REQUEST_RECEIPT_PENDING_MS = 2 * 60 * 1000;

export const REQUEST_RECEIPT_RETENTION_BATCH_SIZE = 128;
const REQUEST_RECEIPT_RETENTION_MS = DAY_IN_MS;
const RETENTION_STATEMENT_BUDGET_MS = 5000;
const RETENTION_LOCK_BUDGET_MS = 1000;

type SweepExpiredRequestReceiptsOptions = {
  db: SchedulerDb;
  now: Date;
  signal: AbortSignal;
  deadline: number;
  elapsedMs?: () => number;
};

export const sweepExpiredRequestReceipts = async ({
  db,
  now,
  signal,
  deadline,
  elapsedMs = () => performance.now(),
}: SweepExpiredRequestReceiptsOptions): Promise<{
  deleted: number;
  hasMore: boolean;
}> => {
  const shouldStop = () => signal.aborted || elapsedMs() >= deadline;
  if (shouldStop()) {
    return { deleted: 0, hasMore: !signal.aborted };
  }
  const completedBefore = new Date(
    now.getTime() - REQUEST_RECEIPT_RETENTION_MS,
  );
  const pendingBefore = new Date(now.getTime() - REQUEST_RECEIPT_PENDING_MS);
  const expired = or(
    and(
      eq(receipts.state, "completed"),
      lt(
        receipts.claimedAt,
        sql`${completedBefore.toISOString()}::timestamptz`,
      ),
    ),
    and(
      eq(receipts.state, "pending"),
      lt(receipts.claimedAt, sql`${pendingBefore.toISOString()}::timestamptz`),
    ),
  );
  // The scheduler reads ownership globally; every delete runs under the row's
  // organization and user policies, even when the supplied connection bypasses RLS.
  // Pending rows become eligible after two minutes; the hourly bounded sweep
  // skips live row locks regardless of age. A process crash releases its lock
  // and rolls back its resource writes before the pending row can be removed.
  // The owner-only lock policy grants UPDATE visibility, not write permission.
  // Discovery also skips live owners, so a full batch of active
  // requests cannot starve abandoned rows behind it. Each sweep handles one
  // principal's bounded set in one scoped delete; the scheduler bounds and
  // continues these rounds. Deletion locks again and rechecks eligibility.
  const readCandidates = async (
    state: typeof receipts.$inferSelect.state,
    before: Date,
  ) =>
    await withSkipLockedBatch({
      database: db,
      limit: REQUEST_RECEIPT_RETENTION_BATCH_SIZE,
      select: (tx) =>
        tx
          .select({
            id: receipts.id,
            organizationId: receipts.organizationId,
            userId: receipts.userId,
            claimedAt: receipts.claimedAt,
          })
          .from(receipts)
          .where(
            and(
              eq(receipts.state, state),
              lt(receipts.claimedAt, sql`${before.toISOString()}::timestamptz`),
            ),
          )
          .orderBy(asc(receipts.claimedAt))
          .limit(REQUEST_RECEIPT_RETENTION_BATCH_SIZE)
          .$dynamic(),
      run: (_tx, rows) => rows,
    });
  const completed = await readCandidates("completed", completedBefore);
  if (shouldStop()) {
    return { deleted: 0, hasMore: true };
  }
  const pending = await readCandidates("pending", pendingBefore);
  const candidates = [...completed, ...pending]
    .toSorted(
      (left, right) => left.claimedAt.getTime() - right.claimedAt.getTime(),
    )
    .slice(0, REQUEST_RECEIPT_RETENTION_BATCH_SIZE);
  const first = candidates.at(0);
  if (first === undefined) {
    return { deleted: 0, hasMore: false };
  }
  if (shouldStop()) {
    return { deleted: 0, hasMore: true };
  }
  const group = candidates.filter(
    (row) =>
      row.organizationId === first.organizationId &&
      row.userId === first.userId,
  );
  const scopedDb = createScopedDb(
    markRlsDatabase(db),
    [],
    first.organizationId,
    brandPersistedUserId(first.userId),
  );
  const rows = await withSkipLockedBatch({
    database: { transaction: scopedDb },
    limit: REQUEST_RECEIPT_RETENTION_BATCH_SIZE,
    select: (tx) =>
      tx
        .select({ id: receipts.id })
        .from(receipts)
        .where(
          and(
            eq(receipts.organizationId, first.organizationId),
            eq(receipts.userId, first.userId),
            inArray(
              receipts.id,
              group.map(({ id }) => id),
            ),
            expired,
          ),
        ),
    run: async (tx, unlocked) => {
      if (unlocked.length === 0) {
        return [];
      }
      await setSharedStatementTimeout(
        tx,
        Math.max(
          1,
          Math.min(RETENTION_STATEMENT_BUDGET_MS, deadline - elapsedMs()),
        ),
      );
      await setSharedLockTimeout(tx, RETENTION_LOCK_BUDGET_MS);
      // audit: skip - Retention removes expired technical receipts under their tenant scope.
      return await tx
        .delete(receipts)
        .where(
          and(
            eq(receipts.organizationId, first.organizationId),
            eq(receipts.userId, first.userId),
            inArray(
              receipts.id,
              unlocked.map(({ id }) => id),
            ),
            expired,
          ),
        )
        .returning({ id: receipts.id });
    },
  });
  return {
    deleted: rows.length,
    hasMore:
      candidates.length === REQUEST_RECEIPT_RETENTION_BATCH_SIZE ||
      group.length < candidates.length,
  };
};
