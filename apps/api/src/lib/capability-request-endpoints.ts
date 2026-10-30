import { panic } from "better-result";

import type { CapabilityEndpoint } from "@/api/lib/capability-request";
import {
  loadCapabilityCatalog,
  loadCapabilityEndpoint,
} from "@/api/mcp/capability-tools";

/** Every catalog capability with the route definition that serves it. */
export const loadCapabilityEndpoints = async (): Promise<
  readonly CapabilityEndpoint[]
> =>
  await Promise.all(
    (await loadCapabilityCatalog()).map(async ({ id }) => {
      const endpoint = await loadCapabilityEndpoint(id);
      if (endpoint === null) {
        return panic(`capability ${id} has no endpoint definition`);
      }
      return { id, definition: endpoint };
    }),
  );
