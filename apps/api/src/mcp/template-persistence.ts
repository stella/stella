import { panic, TaggedError } from "better-result";
import { and, eq, lte } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  TEMPLATE_PERSISTENCE_REQUEST_STATUS,
  templatePersistenceRequests,
  type TemplatePersistenceResult,
} from "@/api/db/schema";
import { createEntityVersionFromBuffer } from "@/api/handlers/entities/create-version-from-buffer";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { sortDeep } from "@/api/lib/sort-deep";

/** Narrow persistence seam shared by template MCP handlers and their tests. */
export const persistFilledTemplateDocument = createEntityFromBuffer;
export const persistFilledTemplateVersion = createEntityVersionFromBuffer;

export const fingerprintTemplatePersistenceRequest = (input: unknown): string =>
  new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(sortDeep(input)))
    .digest("hex");

const TEMPLATE_PERSISTENCE_CLAIM_STALE_MS = 15 * 60 * 1000;

export type TemplatePersistenceClaim =
  | { status: "claimed"; claimToken: string }
  | { status: "completed"; result: TemplatePersistenceResult }
  | { status: "conflict" }
  | { status: "pending" };

export const claimTemplatePersistenceRequest = async ({
  safeDb,
  organizationId,
  workspaceId,
  userId,
  idempotencyKey,
  requestFingerprint,
}: {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  idempotencyKey: string;
  requestFingerprint: string;
}) =>
  await safeDb(async (tx): Promise<TemplatePersistenceClaim> => {
    const claimToken = Bun.randomUUIDv7();
    const claimedAt = new Date();
    const inserted = await tx
      .insert(templatePersistenceRequests)
      .values({
        id: createSafeId<"templatePersistenceRequest">(),
        organizationId,
        workspaceId,
        userId,
        idempotencyKey,
        requestFingerprint,
        status: TEMPLATE_PERSISTENCE_REQUEST_STATUS.PENDING,
        claimToken,
        claimedAt,
      })
      .onConflictDoNothing({
        target: [
          templatePersistenceRequests.organizationId,
          templatePersistenceRequests.userId,
          templatePersistenceRequests.idempotencyKey,
        ],
      })
      .returning({ id: templatePersistenceRequests.id });
    if (inserted.length === 1) {
      return { status: "claimed", claimToken };
    }

    const rows = await tx
      .select({
        claimToken: templatePersistenceRequests.claimToken,
        claimedAt: templatePersistenceRequests.claimedAt,
        requestFingerprint: templatePersistenceRequests.requestFingerprint,
        result: templatePersistenceRequests.result,
        status: templatePersistenceRequests.status,
        workspaceId: templatePersistenceRequests.workspaceId,
      })
      .from(templatePersistenceRequests)
      .where(
        and(
          eq(templatePersistenceRequests.organizationId, organizationId),
          eq(templatePersistenceRequests.userId, userId),
          eq(templatePersistenceRequests.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    const existing = rows.at(0);
    if (
      existing === undefined ||
      existing.workspaceId !== workspaceId ||
      existing.requestFingerprint !== requestFingerprint
    ) {
      return { status: "conflict" };
    }
    if (existing.status === TEMPLATE_PERSISTENCE_REQUEST_STATUS.COMPLETED) {
      return {
        status: "completed",
        result:
          existing.result ??
          panic("Completed template persistence request has no result"),
      };
    }

    const staleBefore = new Date(
      claimedAt.getTime() - TEMPLATE_PERSISTENCE_CLAIM_STALE_MS,
    );
    if (existing.claimedAt > staleBefore) {
      return { status: "pending" };
    }
    const reclaimed = await tx
      .update(templatePersistenceRequests)
      .set({ claimToken, claimedAt })
      .where(
        and(
          eq(templatePersistenceRequests.organizationId, organizationId),
          eq(templatePersistenceRequests.userId, userId),
          eq(templatePersistenceRequests.idempotencyKey, idempotencyKey),
          eq(
            templatePersistenceRequests.status,
            TEMPLATE_PERSISTENCE_REQUEST_STATUS.PENDING,
          ),
          eq(templatePersistenceRequests.claimToken, existing.claimToken),
          lte(templatePersistenceRequests.claimedAt, staleBefore),
        ),
      )
      .returning({ id: templatePersistenceRequests.id });
    return reclaimed.length === 1
      ? { status: "claimed", claimToken }
      : { status: "pending" };
  });

export const releaseTemplatePersistenceClaim = async ({
  safeDb,
  organizationId,
  userId,
  idempotencyKey,
  claimToken,
}: {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  idempotencyKey: string;
  claimToken: string;
}) =>
  await safeDb(async (tx) => {
    // audit: skip — abandoning unfinished idempotency coordination has no
    // product-visible effect.
    await tx
      .delete(templatePersistenceRequests)
      .where(
        and(
          eq(templatePersistenceRequests.organizationId, organizationId),
          eq(templatePersistenceRequests.userId, userId),
          eq(templatePersistenceRequests.idempotencyKey, idempotencyKey),
          eq(templatePersistenceRequests.claimToken, claimToken),
          eq(
            templatePersistenceRequests.status,
            TEMPLATE_PERSISTENCE_REQUEST_STATUS.PENDING,
          ),
        ),
      );
  });

class TemplatePersistenceClaimLostError extends TaggedError(
  "TemplatePersistenceClaimLostError",
)<{ message: string }>() {}

export const recordTemplatePersistenceReceipt = async ({
  tx,
  organizationId,
  workspaceId,
  userId,
  idempotencyKey,
  requestFingerprint,
  claimToken,
  result,
}: {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  idempotencyKey: string;
  requestFingerprint: string;
  claimToken: string;
  result: TemplatePersistenceResult;
}): Promise<void> => {
  // audit: skip — retry coordination; the entity and template-fill mutations
  // are audited in this same transaction.
  const completed = await tx
    .update(templatePersistenceRequests)
    .set({
      status: TEMPLATE_PERSISTENCE_REQUEST_STATUS.COMPLETED,
      result,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(templatePersistenceRequests.organizationId, organizationId),
        eq(templatePersistenceRequests.workspaceId, workspaceId),
        eq(templatePersistenceRequests.userId, userId),
        eq(templatePersistenceRequests.idempotencyKey, idempotencyKey),
        eq(templatePersistenceRequests.requestFingerprint, requestFingerprint),
        eq(templatePersistenceRequests.claimToken, claimToken),
        eq(
          templatePersistenceRequests.status,
          TEMPLATE_PERSISTENCE_REQUEST_STATUS.PENDING,
        ),
      ),
    )
    .returning({ id: templatePersistenceRequests.id });
  if (completed.length !== 1) {
    throw new TemplatePersistenceClaimLostError({
      message: "Template persistence claim was lost before completion",
    });
  }
};
