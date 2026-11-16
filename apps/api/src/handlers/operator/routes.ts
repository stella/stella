import { routes } from "@/api/http/route";

import operatorActivity from "./activity";
import operatorRegistrations, {
  createOperatorRegistrations,
} from "./registrations";
import type { OperatorRegistrationsOptions } from "./registrations";

export const createOperatorRoute = (options: OperatorRegistrationsOptions) =>
  routes(
    {
      "/registrations": { GET: createOperatorRegistrations(options) },
    },
    { prefix: "/operator" },
  );

export const operatorRoute = routes(
  {
    "/activity": { GET: operatorActivity },
    "/registrations": { GET: operatorRegistrations },
  },
  { prefix: "/operator" },
);
