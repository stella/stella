import { readFeatureAccessGrants } from "@/api/env-feature-access";
import { isFeatureDeployed } from "@/api/lib/feature-access/deployment";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import type { FeatureId } from "@/api/lib/feature-access/registry";

type OrganizationFeatureId = {
  [Id in FeatureId]: (typeof FEATURE_REGISTRY)[Id] extends {
    grantScope: "organization";
  }
    ? Id
    : never;
}[FeatureId];

type OrganizationFeatureOptions = {
  featureId: OrganizationFeatureId;
  organizationId: string;
};

/**
 * Organization authority for bearer links and delivery. Personal enrolment is
 * checked when creating the link; recipients need no membership. Deployment
 * prerequisites still apply, and only an organization grant carries authority.
 */
export const isOrganizationFeatureEnabled = ({
  featureId,
  organizationId,
}: OrganizationFeatureOptions): boolean =>
  isFeatureDeployed(FEATURE_REGISTRY, featureId) &&
  readFeatureAccessGrants().grants[featureId]?.some(
    (grant) =>
      grant.type === "organization" && grant.organizationId === organizationId,
  ) === true;
