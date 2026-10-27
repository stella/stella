import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import { resolveRate } from "@/api/lib/billing/rates";
import type { SafeId } from "@/api/lib/branded-types";

export const resolveSuggestionBillingDefault = async function* ({
  safeDb,
  workspaceId,
  userId,
  dateWorked,
}: {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  dateWorked: string;
}) {
  const rate = yield* resolveRate({ safeDb, workspaceId, userId, dateWorked });
  const arrangement = yield* Result.await(
    safeDb((tx) =>
      tx.query.billingArrangements.findFirst({
        where: { workspaceId: { eq: workspaceId } },
        columns: { currency: true },
      }),
    ),
  );
  return {
    billable: rate !== null || arrangement !== undefined,
    rate:
      rate ??
      (arrangement ? { hourlyRate: 0, currency: arrangement.currency } : null),
  };
};
