import type { env } from "@/api/env";
import { featurePrerequisiteClosure } from "@/api/lib/feature-access/prerequisites";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import type { FeatureId } from "@/api/lib/feature-access/registry";

/**
 * Organization grants for the named features and every prerequisite they
 * require, so a fixture cannot enable a feature whose prerequisite is absent.
 * Typed as the env setting itself, so a fixture can install it directly.
 */
export const organizationFeatureGrants = (
  organizationId: string,
  featureIds: readonly FeatureId[],
): typeof env.API_FEATURE_ACCESS_GRANTS =>
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
