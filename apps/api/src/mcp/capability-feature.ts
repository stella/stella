/**
 * Deployment feature gate for catalog capabilities, mirroring
 * `isMcpToolFeatureEnabled` (gateway/list-tools.ts) for the generic invoke
 * path: a catalog entry tagged with a `FEATURE_*` flag is hidden from
 * `list_capabilities` and refused by `describe_capability`/`invoke_capability`
 * while the flag is off, exactly like a feature-tagged static tool. The
 * deployment owner decides each flag's local development access.
 *
 * Lives in its own module (not capability-tools.ts) for two reasons: importing
 * `gateway/list-tools` from capability-tools would be circular
 * (list-tools -> static-tool-definitions -> capability-tools), and callers
 * share the deployment owner's runtime gate.
 */

import {
  isDeploymentFeatureEnabled,
  isDeploymentFeatureFlag,
} from "@/api/lib/deployment-feature";

/** The runtime gate, bound to the deployment env. */
export const isCapabilityFeatureEnabled = (
  feature: string | undefined,
): boolean =>
  feature === undefined ||
  (isDeploymentFeatureFlag(feature) && isDeploymentFeatureEnabled(feature));
