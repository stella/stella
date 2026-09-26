/**
 * Deployment feature gate for catalog capabilities, mirroring
 * `isMcpToolFeatureEnabled` (gateway/list-tools.ts) for the generic invoke
 * path: a catalog entry tagged with a `FEATURE_*` flag is hidden from
 * `list_capabilities` and refused by `describe_capability`/`invoke_capability`
 * while the flag is off, exactly like a feature-tagged static tool. Dev
 * deployments see everything so local work is not blocked.
 *
 * Lives in its own module (not capability-tools.ts) for two reasons: importing
 * `gateway/list-tools` from capability-tools would be circular
 * (list-tools -> static-tool-definitions -> capability-tools), and the tests
 * mock this one seam to simulate a disabled flag without perturbing `env` for
 * the whole module graph.
 */

import { RUNTIME_MODE, type RuntimeMode } from "@stll/runtime-mode";

import { env } from "@/api/env";
import { runtimeMode } from "@/api/runtime-mode";

type FeatureFlagSource = {
  runtimeMode: RuntimeMode;
  flags: Readonly<Record<string, unknown>>;
};

/**
 * Pure core (unit-testable without env mocking): enabled when the entry
 * carries no flag, local development access is open, or the named flag is
 * exactly `true`.
 * The entry's `feature` string is untrusted generated JSON, so anything that
 * is not a `FEATURE_*` key holding boolean true fails closed — a stale or
 * mistyped flag in the artifact can never silently un-gate a capability.
 */
export const featureEnabledIn = (
  feature: string | undefined,
  source: FeatureFlagSource,
): boolean => {
  if (feature === undefined || source.runtimeMode.mode === RUNTIME_MODE.open) {
    return true;
  }
  return feature.startsWith("FEATURE_") && source.flags[feature] === true;
};

/** The runtime gate, bound to the deployment env. */
export const isCapabilityFeatureEnabled = (
  feature: string | undefined,
): boolean =>
  featureEnabledIn(feature, { runtimeMode: runtimeMode(), flags: env });
