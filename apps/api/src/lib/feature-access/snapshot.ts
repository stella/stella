import { envFeatureAccess } from "@/api/env-feature-access";
import { isFeatureDeployed } from "@/api/lib/feature-access/deployment";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import type {
  FeatureAccessDecision,
  FeatureAccessSnapshot,
} from "@/api/lib/feature-access/policy";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import type { FeatureRegistry } from "@/api/lib/feature-access/registry";

type FeatureAccessIdentity = { email: string; emailVerified: boolean };

type BuildFeatureAccessSnapshotOptions = {
  organizationId: string;
  userId: string | null;
  /** The caller's membership identity, or null when they are not a live member. */
  identity: FeatureAccessIdentity | null;
  enrolments: readonly FeatureAccessEnrolment[];
  registry?: FeatureRegistry;
  grants?: FeatureAccessGrants;
};

type FeatureAccessEnrolment = {
  featureId: string;
  organizationId: string;
  userId: string;
};

/**
 * Decide every registered feature for one caller from identity and enrolment
 * facts already read. Request snapshots and database scopes share this owner
 * for grants, enrolments, membership and deployment decisions.
 */
export const buildFeatureAccessSnapshot = ({
  organizationId,
  userId,
  identity,
  enrolments,
  registry = FEATURE_REGISTRY,
  grants = envFeatureAccess.API_FEATURE_ACCESS_GRANTS,
}: BuildFeatureAccessSnapshotOptions): FeatureAccessSnapshot => {
  const decisions = new Map<string, FeatureAccessDecision>();
  for (const featureId of Object.keys(registry)) {
    decisions.set(
      featureId,
      decideFeatureAccess({
        registry,
        grants,
        featureId,
        organizationId,
        userId,
        user: identity,
        membership: identity !== null,
        enrolments,
        // The snapshot owns the deployment switch AND the per-caller decision.
        deploymentEnabled: isFeatureDeployed(registry, featureId),
      }),
    );
  }
  return createFeatureAccessSnapshot({ organizationId, userId, decisions });
};
