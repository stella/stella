import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { chatThreads } from "@/api/db/schema";
import { resolveFeatureAccess } from "@/api/lib/auth/feature-access/context";
import type { SafeId } from "@/api/lib/branded-types";
import { isFeatureDeployed } from "@/api/lib/feature-access/deployment";
import {
  AI_MEMORY_FEATURE_ID,
  FEATURE_REGISTRY,
} from "@/api/lib/feature-access/registry";

type ThreadMemoryAccessOptions = {
  tx: Pick<Transaction, "select">;
  threadId: SafeId<"chatThread">;
  userId?: SafeId<"user">;
};

export const isThreadMemoryEnabled = async ({
  tx,
  threadId,
  userId,
}: ThreadMemoryAccessOptions): Promise<boolean> => {
  if (!isFeatureDeployed(FEATURE_REGISTRY, AI_MEMORY_FEATURE_ID)) {
    return false;
  }
  const thread = (
    await tx
      .select({
        organizationId: chatThreads.organizationId,
        userId: chatThreads.userId,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
      .limit(1)
  ).at(0);
  if (!thread) {
    return false;
  }
  const decision = await resolveFeatureAccess({
    tx,
    organizationId: thread.organizationId,
    userId: userId ?? thread.userId,
    featureId: AI_MEMORY_FEATURE_ID,
  });
  return decision.status === "enabled";
};
