import type { DeploymentFeatureFlag } from "@/api/lib/deployment-feature";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";

/**
 * Whether a deployment-gated agent-facing surface is available.
 *
 * A tool tagged with a `feature` is advertised and dispatchable only while
 * that flag is on, read through the same owner as the backing route's gate
 * (`isDeploymentFeatureEnabled`). Untagged tools are always available.
 *
 * This is the single chokepoint every gated surface shares: the tool list,
 * the dispatch guard, the resource list, and the connect-time instructions
 * that point at a gated workflow. It lives in its own module, importing only
 * the deployment-feature owner, so the resource and instruction modules can reach it without
 * pulling in the tool registry they are listed beside.
 */
export const isMcpToolFeatureEnabled = (
  feature: DeploymentFeatureFlag | undefined,
): boolean => feature === undefined || isDeploymentFeatureEnabled(feature);
