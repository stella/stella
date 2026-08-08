import { Elysia, NotFoundError } from "elysia";

/**
 * Keep a route in the inferred API contract while making the deployed surface
 * indistinguishable from an absent route until its operator enables it.
 */
export const deploymentFeatureGate = (enabled: boolean) =>
  new Elysia().onBeforeHandle({ as: "scoped" }, () => {
    if (!enabled) {
      throw new NotFoundError();
    }
  });
