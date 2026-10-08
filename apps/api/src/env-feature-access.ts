import { panic } from "better-result";

import { envBase } from "@/api/env-base";
import type { DeploymentFeatureFlag } from "@/api/lib/deployment-feature";
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

let deploymentFlagReader: ((flag: DeploymentFeatureFlag) => boolean) | null =
  null;

/**
 * Deployment flags belong to the API environment, which a base-environment
 * process (ingestion, the document worker) never loads. The API environment
 * binds its reader here once, so the flag owner decides for the database
 * layer without importing it.
 */
export const bindDeploymentFlagReader = (
  reader: (flag: DeploymentFeatureFlag) => boolean,
): void => {
  if (deploymentFlagReader !== null) {
    panic("Deployment flags are bound once");
  }
  deploymentFlagReader = reader;
};

/**
 * A deployment flag's configured value. Without the API environment every
 * flag reads at its schema default, off, so such a process admits no flagged
 * feature.
 */
export const readDeploymentFlag = (flag: DeploymentFeatureFlag): boolean =>
  deploymentFlagReader?.(flag) ?? false;
