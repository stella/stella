import { envBase } from "@/api/env-base";
import { logger } from "@/api/lib/observability/logger";
import { isLocalDevOpen } from "@/api/runtime-mode";

if (envBase.API_FEATURE_ACCESS_GRANTS.unknownGrantCount > 0) {
  logger.error("feature_access.unknown_grant", {
    "feature_access.unknown_grant_count":
      envBase.API_FEATURE_ACCESS_GRANTS.unknownGrantCount,
  });
}

/** Grant configuration shared by every authenticated database entrypoint. */
export const envFeatureAccess = {
  API_FEATURE_ACCESS_GRANTS: envBase.API_FEATURE_ACCESS_GRANTS.grants,
};
if (!isLocalDevOpen()) {
  Object.freeze(envFeatureAccess);
}
