import Elysia from "elysia";

import readRegistrations from "@/api/handlers/operator/read-registrations";

/**
 * Operator observability routes. Not session-authed: the handler authorizes
 * itself from the `OPERATOR_METRICS_TOKEN` bearer credential and reports 404
 * whenever that token is not configured, so the surface does not exist on
 * deployments that have not opted in.
 */
export const operatorRoute = new Elysia({ prefix: "/operator" }).get(
  "/registrations",
  readRegistrations.handler,
  readRegistrations.config,
);
