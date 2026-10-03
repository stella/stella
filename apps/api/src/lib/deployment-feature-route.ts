import { Elysia, NotFoundError } from "elysia";

/**
 * Keep a route in the inferred API contract while making the deployed surface
 * indistinguishable from an absent route until its operator enables it.
 * `isEnabled` runs per request, so runtime mode and env flags are read when
 * the request arrives, not when the module loads. It runs at `transform`,
 * before input validation, so a malformed request to a disabled route cannot
 * answer 422 and reveal it. The 404 goes through the error path, so no
 * route's response schema has to admit it.
 */
export const deploymentFeatureGate = (isEnabled: () => boolean) =>
  new Elysia().onTransform({ as: "scoped" }, () => {
    if (!isEnabled()) {
      throw new NotFoundError();
    }
  });
