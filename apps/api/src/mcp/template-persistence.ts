import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { templatePersistenceRequests } from "@/api/db/schema";
import type { TemplatePersistenceResult } from "@/api/db/schema";
import { createEntityFromBuffer } from "@/api/handlers/entities/create-from-buffer";
import { createEntityVersionFromBuffer } from "@/api/handlers/entities/create-version-from-buffer";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { sortDeep } from "@/api/lib/sort-deep";

/** Narrow persistence seam shared by template MCP handlers and their tests. */
export const persistFilledTemplateDocument = createEntityFromBuffer;
export const persistFilledTemplateVersion = createEntityVersionFromBuffer;

export const fingerprintTemplatePersistenceRequest = (input: unknown): string =>
  new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(sortDeep(input)))
    .digest("hex");

export const loadTemplatePersistenceReceipt = async ({
  safeDb,
  organizationId,
  userId,
  idempotencyKey,
}: {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  idempotencyKey: string;
}) =>
  await safeDb(async (tx) => {
    const rows = await tx
      .select({
        requestFingerprint: templatePersistenceRequests.requestFingerprint,
        result: templatePersistenceRequests.result,
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
    return rows.at(0);
  });

export const recordTemplatePersistenceReceipt = async ({
  tx,
  organizationId,
  workspaceId,
  userId,
  idempotencyKey,
  requestFingerprint,
  result,
}: {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  idempotencyKey: string;
  requestFingerprint: string;
  result: TemplatePersistenceResult;
}): Promise<void> => {
  // audit: skip — immutable retry receipt; the entity and template-fill
  // mutations are audited in this same transaction.
  await tx.insert(templatePersistenceRequests).values({
    id: createSafeId<"templatePersistenceRequest">(),
    organizationId,
    workspaceId,
    userId,
    idempotencyKey,
    requestFingerprint,
    result,
  });
};
