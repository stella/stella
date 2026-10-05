import { env } from "@/api/env";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";

export const organizationUpgradeUrl = () =>
  isDeploymentFeatureEnabled("FEATURE_FREE_TIER")
    ? new URL("/settings/organization/billing", env.FRONTEND_URL).href
    : undefined;
