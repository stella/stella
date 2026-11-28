import { panic } from "better-result";

import type { DeploymentFeatureFlag } from "@/api/lib/deployment-feature";

let deploymentFlagReader: ((flag: DeploymentFeatureFlag) => boolean) | null =
  null;

/**
 * Deployment flags belong to the API environment, which a base-environment
 * process (ingestion, the document worker) or the env-free HTTP core never
 * loads. The API environment binds its reader here once, so the flag owner and
 * route gates decide without importing `src/env.ts` or `src/env-base.ts`.
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
