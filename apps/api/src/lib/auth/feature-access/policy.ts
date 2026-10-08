import { panic } from "better-result";

import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import { deploymentFeatureFor } from "@/api/lib/feature-access/registry";
import type { FeatureRegistry } from "@/api/lib/feature-access/registry";

const featureAccessProof = Symbol("featureAccessProof");

export type FeatureAccessProof = {
  readonly [featureAccessProof]: true;
  readonly featureId: string;
  readonly organizationId: string;
  readonly userId: string;
};

export type FeatureAccessDecision =
  | { status: "enabled"; proof: FeatureAccessProof }
  | { status: "hidden" };

export type FeatureAccessPrincipal = {
  readonly organizationId: string;
  readonly userId: string | null;
};

export type FeatureAccessSnapshot = FeatureAccessPrincipal & {
  readonly decisions: ReadonlyMap<string, FeatureAccessDecision>;
};

type DecideFeatureAccessOptions = {
  registry: FeatureRegistry;
  grants: FeatureAccessGrants;
  featureId: string;
  organizationId: string;
  userId: string | null;
  user: { email: string; emailVerified: boolean } | null;
  membership: boolean;
  enrolments?: readonly {
    featureId: string;
    organizationId: string;
    userId: string;
  }[];
  deploymentEnabled?: boolean;
};

export const decideFeatureAccess = ({
  registry,
  grants,
  featureId,
  organizationId,
  userId,
  user,
  membership,
  enrolments = [],
  deploymentEnabled = true,
}: DecideFeatureAccessOptions): FeatureAccessDecision => {
  const definition = Object.hasOwn(registry, featureId)
    ? registry[featureId]
    : undefined;
  if (definition === undefined) {
    return panic("Feature access requires a registered feature");
  }
  if (
    !deploymentEnabled ||
    !membership ||
    userId === null ||
    user === null ||
    !user.emailVerified
  ) {
    return { status: "hidden" };
  }
  switch (definition.enrolment) {
    case "self-serve": {
      if (
        !enrolments.some(
          (row) =>
            row.featureId === featureId &&
            row.organizationId === organizationId &&
            row.userId === userId,
        )
      ) {
        return { status: "hidden" };
      }
      return {
        status: "enabled",
        proof: {
          [featureAccessProof]: true,
          featureId,
          organizationId,
          userId,
        },
      };
    }
    case "invitation": {
      const email = user.email.trim().toLowerCase();
      const enabled = grants[featureId]?.some((grant) => {
        if (grant.organizationId !== organizationId) {
          return false;
        }
        switch (grant.type) {
          case "organization":
            return true;
          case "member":
            return grant.email.trim().toLowerCase() === email;
          default: {
            grant satisfies never;
            return panic("Feature access requires a supported grant type");
          }
        }
      });
      if (enabled !== true) {
        return { status: "hidden" };
      }
      return {
        status: "enabled",
        proof: {
          [featureAccessProof]: true,
          featureId,
          organizationId,
          userId,
        },
      };
    }
    default: {
      definition.enrolment satisfies never;
      return panic("Feature access requires a supported enrolment kind");
    }
  }
};

export const isFeatureAccessSnapshotForPrincipal = (
  snapshot: FeatureAccessSnapshot,
  principal: FeatureAccessPrincipal,
): boolean =>
  snapshot.organizationId === principal.organizationId &&
  snapshot.userId === principal.userId;

type CreateFeatureAccessSnapshotOptions = FeatureAccessPrincipal & {
  decisions: ReadonlyMap<string, FeatureAccessDecision>;
};

export const createFeatureAccessSnapshot = ({
  organizationId,
  userId,
  decisions,
}: CreateFeatureAccessSnapshotOptions): FeatureAccessSnapshot => {
  for (const [featureId, decision] of decisions) {
    if (
      decision.status === "enabled" &&
      (decision.proof.featureId !== featureId ||
        decision.proof.organizationId !== organizationId ||
        decision.proof.userId !== userId)
    ) {
      return panic(
        "Feature access snapshot decisions must match their principal and feature",
      );
    }
  }
  return { organizationId, userId, decisions };
};

export const isFeatureEnabled = (
  snapshot: FeatureAccessSnapshot,
  featureId: string | undefined,
  principal: FeatureAccessPrincipal,
): boolean => {
  if (featureId === undefined) {
    return true;
  }
  const deploymentFeature = deploymentFeatureFor(featureId);
  if (
    deploymentFeature !== undefined &&
    !isDeploymentFeatureEnabled(deploymentFeature)
  ) {
    return false;
  }
  if (!isFeatureAccessSnapshotForPrincipal(snapshot, principal)) {
    return false;
  }
  const decision = snapshot.decisions.get(featureId);
  return (
    decision?.status === "enabled" &&
    decision.proof.featureId === featureId &&
    decision.proof.organizationId === principal.organizationId &&
    decision.proof.userId === principal.userId
  );
};
