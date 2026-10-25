import { panic } from "better-result";

import type { Transaction } from "@/api/db/root";
import {
  BUFFER_OBJECT_CLEANUP_INTENT_STATUS,
  bufferObjectCleanupIntents,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockLegacyOrganizationObjectIntentKey,
  withAggregateLock,
} from "@/api/lib/db/aggregate-lock";

// Production CopyObject calls abort after 30 seconds. Renewal before and after
// every bounded storage batch keeps the live-writer lease far beyond that
// request bound while recovery retries retain the exact key for late delivery.
export const PREPUBLICATION_COPY_INTENT_LEASE_MS = 10 * 60_000;

type WritingObjectCleanupIntent = {
  chatThreadId: SafeId<"chatThread"> | null;
  id: SafeId<"pendingUpload">;
  nextAttemptAt: Date;
  objectKey: string;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace"> | null;
  writerUserId?: SafeId<"user"> | null | undefined;
};

/** Persist crash-recovery ownership before an object writer starts. */
export const insertWritingObjectCleanupIntents = async (
  tx: Transaction,
  intents: readonly WritingObjectCleanupIntent[],
): Promise<void> => {
  if (intents.length === 0) {
    return;
  }
  // audit: skip - crash-recovery ownership for a later audited mutation.
  await tx.insert(bufferObjectCleanupIntents).values(
    intents.map((intent) => ({
      ...intent,
      status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.WRITING,
    })),
  );
};

/** Serialize an exact-key writer with organization lifecycle teardown. */
export const lockOrganizationObjectIntentsForWriter = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<void> => {
  const result = await withAggregateLock({
    aggregate: "organizationObjectIntent",
    id: organizationId,
    mode: "shared",
    tx,
  });
  if (result.status !== "locked") {
    return panic("Organization object-intent writer fence was not acquired");
  }
  await lockLegacyOrganizationObjectIntentKey(tx, organizationId, "shared");
};

/** Exclude new exact-key writers while lifecycle teardown transfers intents. */
export const lockOrganizationObjectIntentsForLifecycle = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<void> => {
  const result = await withAggregateLock({
    aggregate: "organizationObjectIntent",
    id: organizationId,
    mode: "exclusive",
    tx,
  });
  if (result.status !== "locked") {
    return panic("Organization object-intent lifecycle fence was not acquired");
  }
  await lockLegacyOrganizationObjectIntentKey(tx, organizationId, "exclusive");
};
