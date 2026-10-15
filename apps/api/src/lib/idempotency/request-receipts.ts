import { panic } from "better-result";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia";

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
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { toJsonValue } from "@/api/lib/json-value";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import type { SchedulerDb } from "@/api/lib/scheduler/types";

export const REQUEST_RECEIPT_PENDING_MS = 2 * 60 * 1000;

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
  | { type: "key_reused" };

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
    throw new HandlerError({
      status: 400,
      message: "Idempotency-Key must contain 1 to 128 characters.",
    });
  }
  return await scopedDb(async (tx) => {
    // audit: skip - Ephemeral request coordination; the create handler audits its resource mutation.
    const id = createSafeId<"requestIdempotencyReceipt">();
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

    const match = and(
      eq(receipts.organizationId, organizationId),
      eq(receipts.userId, userId),
      eq(receipts.idempotencyKey, key),
    );
    // A release can race the conflicting insert; taking the key again on the
    // next request is safe, while running without an owned receipt is not.
    const existing = (
      await tx.select().from(receipts).where(match).limit(1)
    ).at(0);
    if (!existing) {
      return { type: "in_progress" };
    }
    if (existing.requestFingerprint !== fingerprint) {
      return { type: "key_reused" };
    }
    if (existing.state === "completed") {
      if (existing.responseStatus === null) {
        panic("Completed receipt has no response status");
      }
      return {
        type: "replay",
        status: existing.responseStatus,
        body: existing.responseBody,
      };
    }
    const staleBefore = new Date(now.getTime() - REQUEST_RECEIPT_PENDING_MS);
    const taken = await tx
      .update(receipts)
      .set({ id, claimedAt: now })
      .where(
        and(
          match,
          eq(receipts.id, existing.id),
          eq(receipts.state, "pending"),
          lt(
            receipts.claimedAt,
            sql`${staleBefore.toISOString()}::timestamptz`,
          ),
        ),
      )
      .returning({ id: receipts.id });
    return taken.length > 0 ? { type: "claimed", id } : { type: "in_progress" };
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
    // audit: skip - Completion caches an already audited create response for replay.
    await tx
      .update(receipts)
      .set({
        state: "completed",
        responseStatus: status,
        responseBody: body,
        completedAt: new Date(),
      })
      .where(and(eq(receipts.id, id), eq(receipts.state, "pending")));
  });
};

export const releaseRequestReceipt = async ({
  scopedDb,
  id,
}: ReceiptIdentity): Promise<void> => {
  await scopedDb(async (tx) => {
    // audit: skip - Releasing failed ephemeral request coordination does not mutate a resource.
    await tx
      .delete(receipts)
      .where(and(eq(receipts.id, id), eq(receipts.state, "pending")));
  });
};

type ReplayRequestOptions<T> = ClaimRequestReceiptOptions & {
  run: () => Promise<T>;
  responseStatus: () => number;
};

// A replay writes the serialized transport response of the original T. Keep
// the handler's inferred payload contract; Response is an implementation detail
// of replaying that same JSON through Elysia, not another payload schema.
export function runWithRequestReceipt<T>(
  options: ReplayRequestOptions<T>,
): Promise<T>;
export async function runWithRequestReceipt<T>({
  run,
  responseStatus,
  ...options
}: ReplayRequestOptions<T>): Promise<unknown> {
  const claim = await claimRequestReceipt(options);
  switch (claim.type) {
    case "replay":
      return new Response(
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
      );
    case "in_progress":
      throw new HandlerError({
        status: 409,
        code: IDEMPOTENCY_IN_PROGRESS_CODE,
        message: "This request is still in progress.",
      });
    case "key_reused":
      throw new HandlerError({
        status: 422,
        code: IDEMPOTENCY_KEY_REUSED_CODE,
        message: "This key was already used for a different request.",
      });
    case "claimed": {
      let settled = false;
      try {
        const result = await run();
        let body: unknown = result;
        let status = responseStatus();
        while (body instanceof ElysiaCustomStatusResponse) {
          status = body.code;
          body = body.response;
        }
        if (status < 200 || status >= 300) {
          return result;
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
        settled = true;
        await completeRequestReceipt({
          scopedDb: options.scopedDb,
          id: claim.id,
          status,
          body,
        });
        return result;
      } finally {
        if (!settled) {
          await releaseRequestReceipt({
            scopedDb: options.scopedDb,
            id: claim.id,
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
  if (signal.aborted) {
    return { deleted: 0, hasMore: false };
  }
  if (elapsedMs() >= deadline) {
    return { deleted: 0, hasMore: true };
  }
  const cutoff = new Date(now.getTime() - REQUEST_RECEIPT_RETENTION_MS);
  // The scheduler reads ownership globally; every delete runs under the row's
  // organization and user policies, even when the supplied connection bypasses RLS.
  const candidates = await withAggregateTransaction(db, async (tx) => {
    await setSharedStatementTimeout(
      tx,
      Math.max(
        1,
        Math.min(RETENTION_STATEMENT_BUDGET_MS, deadline - elapsedMs()),
      ),
    );
    await setSharedLockTimeout(tx, RETENTION_LOCK_BUDGET_MS);
    return await tx
      .select({
        id: receipts.id,
        organizationId: receipts.organizationId,
        userId: receipts.userId,
      })
      .from(receipts)
      .where(lt(receipts.claimedAt, sql`${cutoff.toISOString()}::timestamptz`))
      .orderBy(asc(receipts.claimedAt), asc(receipts.id))
      .limit(REQUEST_RECEIPT_RETENTION_BATCH_SIZE);
  });
  const groups = new Map<string, typeof candidates>();
  for (const row of candidates) {
    const key = `${row.organizationId}:${row.userId}`;
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  let deleted = 0;
  let groupsProcessed = 0;
  const database = markRlsDatabase(db);
  for (const group of groups.values()) {
    if (signal.aborted || elapsedMs() >= deadline) {
      break;
    }
    const first =
      group.at(0) ?? panic("Receipt retention group must have a row");
    const scopedDb = createScopedDb(
      database,
      [],
      first.organizationId,
      brandPersistedUserId(first.userId),
    );
    const rows = await scopedDb(async (tx) => {
      // audit: skip - Retention removes expired technical response receipts, not user resources.
      await setSharedStatementTimeout(
        tx,
        Math.max(
          1,
          Math.min(RETENTION_STATEMENT_BUDGET_MS, deadline - elapsedMs()),
        ),
      );
      await setSharedLockTimeout(tx, RETENTION_LOCK_BUDGET_MS);
      return await tx
        .delete(receipts)
        .where(
          and(
            eq(receipts.organizationId, first.organizationId),
            eq(receipts.userId, first.userId),
            inArray(
              receipts.id,
              group.map(({ id }) => id),
            ),
            lt(receipts.claimedAt, sql`${cutoff.toISOString()}::timestamptz`),
          ),
        )
        .returning({ id: receipts.id });
    });
    deleted += rows.length;
    groupsProcessed += 1;
  }
  return {
    deleted,
    hasMore:
      candidates.length === REQUEST_RECEIPT_RETENTION_BATCH_SIZE ||
      groupsProcessed < groups.size,
  };
};
