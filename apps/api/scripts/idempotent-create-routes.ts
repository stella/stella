import { panic } from "better-result";

import {
  collectIdempotentCreateRoutes,
  CREATE_ROUTES_MARKER,
} from "@stll/scripts/src/idempotent-create-routes";

import { apiRoutes } from "@/api/api-routes";

import { deriveCapabilityId } from "./lib/capability-catalog";
import { discoverSafeHandlers } from "./lib/enumerate-safe-handlers";

export const mountedCreateRouteCensus = async () => {
  const discovery = await discoverSafeHandlers();
  if (discovery.importErrors.length > 0) {
    panic(
      `Cannot discover create route owners: ${JSON.stringify(discovery.importErrors)}`,
    );
  }
  return collectIdempotentCreateRoutes({
    routes: apiRoutes,
    endpoints: discovery.endpoints.map((endpoint) => ({
      definition: endpoint.definition,
      file: endpoint.file.replace(/^apps\/api\//u, ""),
      create:
        endpoint.file.endsWith("/create.ts") ||
        deriveCapabilityId(endpoint).endsWith(".create"),
    })),
  });
};

if (import.meta.main) {
  console.log(
    `${CREATE_ROUTES_MARKER}${JSON.stringify(await mountedCreateRouteCensus())}`,
  );
  process.exit(0);
}
