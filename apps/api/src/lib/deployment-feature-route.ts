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

const exceptionGatedFlags = new WeakMap<Middleware, DeploymentFeatureFlag>();

/**
 * A deployment gate with one exception the request proves by its own body:
 * while the flag is off, a request `admits` accepts still reaches the route,
 * and every other one, a malformed one included, answers as an absent route.
 * `admits` reads a copy of the request, so the route still reads the body.
 */
export const deploymentFeatureGateExcept = (
  flag: DeploymentFeatureFlag,
  admits: (request: Request) => Promise<boolean>,
  {
    isEnabled = () => isDeploymentFeatureEnabled(flag),
  }: {
    /** A test seam; the gate still stands for `flag`. */
    isEnabled?: () => boolean;
  } = {},
): Middleware => {
  const gate: Middleware = async (ctx, inner) => {
    if (!isEnabled() && !(await admits(ctx.request.clone()))) {
      throw new HttpFailureError(HTTP_FAILURE.notFound);
    }
    return await inner();
  };
  exceptionGatedFlags.set(gate, flag);
  return gate;
};

/** The flag an exception gate stands for, or `undefined` for any other. */
export const deploymentFeatureGateExceptionFlag = (
  middleware: Middleware,
): DeploymentFeatureFlag | undefined => exceptionGatedFlags.get(middleware);

/** Routes that exist only while local development access is open. */
export const localDevelopmentGate: Middleware = absentUnless(isLocalDevOpen);
