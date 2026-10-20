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
    {
      query: registrations.config.query,
    },
    registrations.handler,
  );
};

export const operatorRoute = new Elysia({ prefix: "/operator" })
  .get(
    "/activity",
    {
      query: operatorActivity.config.query,
    },
    operatorActivity.handler,
  )
  .get(
    "/registrations",
    {
      query: operatorRegistrations.config.query,
    },
    operatorRegistrations.handler,
  );
