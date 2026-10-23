import { HTTP_FAILURE, HttpFailureError } from "@/api/http/errors";
import type { Middleware } from "@/api/http/route";
import {
  type DeploymentFeatureFlag,
  isDeploymentFeatureEnabled,
} from "@/api/lib/deployment-feature";
import { isLocalDevOpen } from "@/api/runtime-mode";

const gatedFlags = new WeakMap<Middleware, DeploymentFeatureFlag>();

const absentUnless =
  (isEnabled: () => boolean): Middleware =>
  async (_ctx, inner) => {
    if (!isEnabled()) {
      throw new HttpFailureError(HTTP_FAILURE.notFound);
    }
    return await inner();
  };

/**
 * Keep a route mounted while making the deployed surface indistinguishable
 * from an absent route until its operator enables the flag. The flag is read
 * per request, so runtime mode and env are read when the request arrives, not
 * when the module loads. It runs before the route reads its input, so a
 * malformed request to a disabled route cannot answer 422 and reveal it.
 */
export const deploymentFeatureGate = (
  flag: DeploymentFeatureFlag,
  {
    isEnabled = () => isDeploymentFeatureEnabled(flag),
  }: {
    /** A test seam; the gate still stands for `flag`. */
    isEnabled?: () => boolean;
  } = {},
): Middleware => {
  const gate = absentUnless(isEnabled);
  gatedFlags.set(gate, flag);
  return gate;
};

/** The flag a route gate stands for, or `undefined` for any other middleware. */
export const deploymentFeatureGateFlag = (
  middleware: Middleware,
): DeploymentFeatureFlag | undefined => gatedFlags.get(middleware);

/** Routes that exist only while local development access is open. */
export const localDevelopmentGate: Middleware = absentUnless(isLocalDevOpen);
