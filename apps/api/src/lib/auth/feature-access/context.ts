import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import {
  resolveFeatureAccessSnapshot,
  type ResolveFeatureAccessSnapshotOptions,
} from "@/api/lib/feature-access/live-snapshot";
import { createFeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import type { FeatureAccessDecision } from "@/api/lib/feature-access/policy";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";

export { resolveFeatureAccessSnapshot };

type ResolveFeatureAccessOptions = ResolveFeatureAccessSnapshotOptions & {
  featureId: string;
};

export const resolveFeatureAccess = async ({
  featureId,
  ...options
}: ResolveFeatureAccessOptions): Promise<FeatureAccessDecision> => {
  const snapshot = await resolveFeatureAccessSnapshot(options);
  return snapshot.decisions.get(featureId) ?? { status: "hidden" };
};

type LoadFeatureAccessSnapshotOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: string | null;
};

export const loadFeatureAccessSnapshot = async ({
  safeDb,
  organizationId,
  userId,
}: LoadFeatureAccessSnapshotOptions) => {
  if (Object.keys(FEATURE_REGISTRY).length === 0) {
    return Result.ok(
      createFeatureAccessSnapshot({
        organizationId,
        userId,
        decisions: new Map(),
      }),
    );
  }
  return await safeDb(
    async (tx) =>
      await resolveFeatureAccessSnapshot({
        tx,
        organizationId,
        userId,
      }),
  );
};
