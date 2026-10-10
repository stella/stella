import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { featurePrerequisiteClosure } from "@/api/lib/feature-access/prerequisites";
import type { FeatureRegistry } from "@/api/lib/feature-access/registry";

/**
 * Whether the deployment offers a feature: every feature in its prerequisite
 * closure that names a deployment flag needs that flag on. The request
 * snapshot and the database scope both decide through here, so row policies
 * never admit a feature whose routes the deployment hides.
 */
export const isFeatureDeployed = (
  registry: FeatureRegistry,
  featureId: string,
): boolean =>
  [...featurePrerequisiteClosure(registry, featureId)].every((id) => {
    const flag = registry[id]?.deploymentFeature;
    return flag === undefined || isDeploymentFeatureEnabled(flag);
  });
