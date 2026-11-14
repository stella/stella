import type { Middleware } from "@/api/http/route";
import { featureAccessGateFeature } from "@/api/lib/auth/feature-access/route";
import { deploymentFeatureGateFlag } from "@/api/lib/deployment-feature-route";
import { isRouteBudget } from "@/api/lib/rate-limit/rate-limit";

/**
 * How a route middleware relates to the capability executors, which run a
 * capability's definition without its route middleware.
 */
export type RouteGate =
  /** Spends a budget only; the executors draw on budgets of their own. */
  | { readonly kind: "budget" }
  /** Hides the route unless a deployment flag is on. */
  | { readonly kind: "deployment-feature"; readonly flag: string }
  /** Hides the route unless the caller has a feature. */
  | { readonly kind: "feature-access"; readonly featureId: string }
  /** Anything else: a gate the executors would bypass. */
  | { readonly kind: "other" };

export const classifyRouteGate = (middleware: Middleware): RouteGate => {
  if (isRouteBudget(middleware)) {
    return { kind: "budget" };
  }
  const flag = deploymentFeatureGateFlag(middleware);
  if (flag !== undefined) {
    return { kind: "deployment-feature", flag };
  }
  const featureId = featureAccessGateFeature(middleware);
  return featureId === undefined
    ? { kind: "other" }
    : { kind: "feature-access", featureId };
};
