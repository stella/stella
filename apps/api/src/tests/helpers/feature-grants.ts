import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import { featurePrerequisiteClosure } from "@/api/lib/feature-access/prerequisites";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import type { FeatureId } from "@/api/lib/feature-access/registry";

/**
 * Organization grants for the named features and every prerequisite they
 * require, so a fixture cannot enable a feature whose prerequisite is absent.
 */
export const organizationFeatureGrants = (
  organizationId: string,
  featureIds: readonly FeatureId[],
): FeatureAccessGrants =>
  Object.fromEntries(
    [
      ...new Set(
        featureIds.flatMap((featureId) => [
          ...featurePrerequisiteClosure(FEATURE_REGISTRY, featureId),
        ]),
      ),
    ].map((featureId) => [
      featureId,
      [{ type: "organization", organizationId }],
    ]),
  );
