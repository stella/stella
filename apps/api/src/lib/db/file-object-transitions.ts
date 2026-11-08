import { and, eq, gt, inArray, lte, or, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  FILE_USAGE_RECONCILIATION_STATE,
  fileComparisonUploads,
  organizationFileObjects,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { TransitionTransaction } from "@/api/lib/db/transitions";

/**
 * Lifecycle transitions of stored file objects and comparison inputs: byte
 * reservations, short processing claims and reconciliation bookkeeping. The
 * generic transition machinery lives in `transitions.ts`; this module holds
 * the file-object specific statements beside it.
 */

type OrganizationFileReservationMutation = {
  expectedSha256Hex: string | null;
  objectKey: string;
  organizationId: string;
  reservedDelta: string;
  sizeBytes: string;
  writeId: string;
};

/** Atomically reserve file-object lifecycles and their organization counters. */
export const reserveOrganizationFileObjectTransitions = async (
  tx: Pick<TransitionTransaction, "execute">,
  mutations: readonly OrganizationFileReservationMutation[],
) => {
  if (mutations.length === 0) {
    return [];
  }
  // audit: skip - internal reservation bookkeeping; the owning publication
  // transaction records the durable resource mutation.
  return executedRows(
    await tx.execute(sql`
      with input as (
        select * from jsonb_to_recordset(${JSON.stringify(mutations)}::text::jsonb)
        as x("organizationId" text, "objectKey" text, "sizeBytes" bigint, "writeId" text, "expectedSha256Hex" text, "reservedDelta" bigint)
      ), changed as (
        insert into organization_file_objects (
          organization_id, object_key, size_bytes, status, write_id,
          expected_sha256_hex, reservation_started_at, reconciliation_state,
          reconciliation_attempt_count, reconcile_after
        )
        select
          "organizationId", "objectKey", "sizeBytes", 'reserved', "writeId",
          "expectedSha256Hex", now(), 'active', 0, now() + interval '1 hour'
        from input
        on conflict (object_key) do update set
          pending_size_bytes = excluded.size_bytes,
          write_id = excluded.write_id,
          expected_sha256_hex = excluded.expected_sha256_hex,
          reservation_started_at = excluded.reservation_started_at,
          reconciliation_state = 'active',
          reconciliation_attempt_count = 0,
          reconcile_after = excluded.reconcile_after,
          updated_at = now()
        where organization_file_objects.organization_id = excluded.organization_id
          and organization_file_objects.write_id is null
        returning object_key
      ), deltas as (
        select "organizationId", sum("reservedDelta") as reserved
        from input join changed on changed.object_key = input."objectKey"
        group by "organizationId"
      )
      update organization_file_usage u set
        reserved_bytes = u.reserved_bytes + d.reserved,
        updated_at = now()
      from deltas d where u.organization_id = d."organizationId"
      returning (select count(*)::int from changed) as changed_count
    `),
  );
};

type FileComparisonClaimArgs = {
  baseUploadId: SafeId<"fileComparisonUpload">;
  claimId: string;
  now: Date;
  organizationId: SafeId<"organization">;
  renew: boolean;
  targetUploadId: SafeId<"fileComparisonUpload">;
  ttlMs: number;
  userId: SafeId<"user">;
};

/** Claim or renew exactly one caller-owned comparison input pair. */
export const claimFileComparisonInputTransitions = async (
  tx: Pick<Transaction, "update">,
  {
    baseUploadId,
    claimId,
    now,
    organizationId,
    renew,
    targetUploadId,
    ttlMs,
    userId,
  }: FileComparisonClaimArgs,
) =>
  // audit: skip - short-lived processing claim bookkeeping only.
  await tx
    .update(fileComparisonUploads)
    .set({
      claimExpiresAt: new Date(now.getTime() + ttlMs),
      claimId,
      status: "processing",
    })
    .where(
      and(
        inArray(fileComparisonUploads.id, [baseUploadId, targetUploadId]),
        eq(fileComparisonUploads.userId, userId),
        eq(fileComparisonUploads.organizationId, organizationId),
        eq(fileComparisonUploads.kind, "input"),
        renew
          ? and(
              eq(fileComparisonUploads.status, "processing"),
              eq(fileComparisonUploads.claimId, claimId),
            )
          : and(
              gt(fileComparisonUploads.expiresAt, sql`${now}::timestamptz`),
              or(
                inArray(fileComparisonUploads.status, ["pending", "ready"]),
                and(
                  eq(fileComparisonUploads.status, "processing"),
                  lte(
                    fileComparisonUploads.claimExpiresAt,
                    sql`${now}::timestamptz`,
                  ),
                ),
              ),
            ),
      ),
    )
    .returning({
      declaredName: fileComparisonUploads.declaredName,
      declaredSha256: fileComparisonUploads.declaredSha256,
      declaredSize: fileComparisonUploads.declaredSize,
      id: fileComparisonUploads.id,
    });

type FileComparisonReleaseArgs = Pick<
  FileComparisonClaimArgs,
  "baseUploadId" | "claimId" | "organizationId" | "targetUploadId" | "userId"
>;

/** Release a still-owned comparison claim so the caller can retry. */
export const releaseFileComparisonInputTransitions = async (
  tx: Pick<Transaction, "update">,
  {
    baseUploadId,
    claimId,
    organizationId,
    targetUploadId,
    userId,
  }: FileComparisonReleaseArgs,
) =>
  // audit: skip - short-lived processing claim bookkeeping only.
  await tx
    .update(fileComparisonUploads)
    .set({ claimExpiresAt: null, claimId: null, status: "ready" })
    .where(
      and(
        inArray(fileComparisonUploads.id, [baseUploadId, targetUploadId]),
        eq(fileComparisonUploads.userId, userId),
        eq(fileComparisonUploads.organizationId, organizationId),
        eq(fileComparisonUploads.status, "processing"),
        eq(fileComparisonUploads.claimId, claimId),
      ),
    );

type FileComparisonSettleArgs = Pick<
  FileComparisonClaimArgs,
  "claimId" | "now" | "organizationId" | "userId"
> & {
  status: "consumed" | "failed";
  uploadIds: readonly SafeId<"fileComparisonUpload">[];
};

/**
 * Settle claimed inputs only while this claim still owns them. A claim that a
 * retry reclaimed carries another id, so a stale worker settles nothing, and a
 * settled input can no longer be reclaimed.
 */
export const settleFileComparisonInputTransitions = async (
  tx: Pick<Transaction, "update">,
  {
    claimId,
    now,
    organizationId,
    status,
    uploadIds,
    userId,
  }: FileComparisonSettleArgs,
) =>
  // audit: skip - the comparison's own event answers for its inputs.
  await tx
    .update(fileComparisonUploads)
    .set({ claimExpiresAt: null, claimId: null, expiresAt: now, status })
    .where(
      and(
        inArray(fileComparisonUploads.id, [...uploadIds]),
        eq(fileComparisonUploads.userId, userId),
        eq(fileComparisonUploads.organizationId, organizationId),
        eq(fileComparisonUploads.kind, "input"),
        eq(fileComparisonUploads.status, "processing"),
        eq(fileComparisonUploads.claimId, claimId),
      ),
    )
    .returning({ id: fileComparisonUploads.id });

type OrganizationFileMismatchArgs = {
  objectKeys: readonly string[];
  quarantineAfterAttempts: number;
  writeId: string;
};

/**
 * Count one more failed verification of still-owned active write rows and
 * quarantine a row once it reaches the bound, keeping its key, write identity
 * and byte reservation for operator repair.
 */
export const recordOrganizationFileMismatchTransitions = async (
  tx: Pick<Transaction, "update">,
  {
    objectKeys,
    quarantineAfterAttempts,
    writeId,
  }: OrganizationFileMismatchArgs,
) =>
  // audit: skip - bounded recovery bookkeeping keeps the reservation intact.
  await tx
    .update(organizationFileObjects)
    .set({
      reconciliationAttemptCount: sql`${organizationFileObjects.reconciliationAttemptCount} + 1`,
      reconciliationState: sql`CASE
        WHEN ${organizationFileObjects.reconciliationAttemptCount} + 1 >= ${quarantineAfterAttempts}
          THEN ${FILE_USAGE_RECONCILIATION_STATE.QUARANTINED}
        ELSE ${FILE_USAGE_RECONCILIATION_STATE.ACTIVE}
      END`,
      reconcileAfter: sql`CASE
        WHEN ${organizationFileObjects.reconciliationAttemptCount} + 1 >= ${quarantineAfterAttempts}
          THEN NULL
        ELSE ${organizationFileObjects.reconcileAfter}
      END`,
    })
    .where(
      and(
        inArray(organizationFileObjects.objectKey, [...objectKeys]),
        eq(organizationFileObjects.writeId, writeId),
        eq(
          organizationFileObjects.reconciliationState,
          FILE_USAGE_RECONCILIATION_STATE.ACTIVE,
        ),
      ),
    );
