import { panic } from "better-result";

import { readFeatureAccessGrants } from "@/api/env-feature-access";
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
import { featurePrerequisiteClosure } from "@/api/lib/feature-access/prerequisites";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import type { FeatureRegistry } from "@/api/lib/feature-access/registry";

type FeatureAccessReadPlanOptions = {
  organizationId: string;
  enrolmentSource?: "database" | "none";
  registry?: FeatureRegistry;
  grants?: FeatureAccessGrants;
};

/** Identity is needed only for a feature that can admit this organization. */
export const featureAccessReadPlan = ({
  organizationId,
  enrolmentSource = "database",
  registry = FEATURE_REGISTRY,
  grants = readFeatureAccessGrants().grants,
}: FeatureAccessReadPlanOptions) => {
  const definitions = new Map(Object.entries(registry));
  const enrolmentKind = (id: string) =>
    definitions.get(id)?.enrolment ??
    panic("Feature read plan requires a registered feature");
  const candidates = Object.keys(registry).filter(
    (id) =>
      isFeatureDeployed(registry, id) &&
      [...featurePrerequisiteClosure(registry, id)].every((required) => {
        const enrolment = enrolmentKind(required);
        switch (enrolment) {
          case "general-availability":
            return true;
          case "self-serve":
            return enrolmentSource === "database";
          case "invitation":
            return (
              grants[required]?.some(
                (grant) => grant.organizationId === organizationId,
              ) === true
            );
          default:
            enrolment satisfies never;
            return panic(
              "Feature read plan requires a supported enrolment kind",
            );
        }
      }),
  );
  const enrolmentFeatureIds = [
    ...new Set(
      candidates.flatMap((id) =>
        [...featurePrerequisiteClosure(registry, id)].filter(
          (required) => enrolmentKind(required) === "self-serve",
        ),
      ),
    ),
  ];
  return { candidates, enrolmentFeatureIds };
};

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
  grants = readFeatureAccessGrants().grants,
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
