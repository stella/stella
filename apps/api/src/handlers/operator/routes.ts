import Elysia from "elysia";

import operatorActivity from "./activity";
import operatorRegistrations, {
  createOperatorRegistrations,
} from "./registrations";
import type { OperatorRegistrationsOptions } from "./registrations";

export const createOperatorRoute = (options: OperatorRegistrationsOptions) => {
  const registrations = createOperatorRegistrations(options);
  return new Elysia({ prefix: "/operator" }).get(
    "/registrations",
    registrations.handler,
    {
      query: registrations.config.query,
    },
  );
};

export const operatorRoute = new Elysia({ prefix: "/operator" })
  .get("/activity", operatorActivity.handler, {
    query: operatorActivity.config.query,
  })
  .get("/registrations", operatorRegistrations.handler, {
    query: operatorRegistrations.config.query,
  });
