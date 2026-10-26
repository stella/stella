import { describe, expect, test } from "bun:test";

import { apiRoutes } from "@/api/api-routes";
import { buildCapabilityIndex } from "@/api/lib/capability-request";
import { loadCapabilityEndpoints } from "@/api/lib/capability-request-endpoints";

describe("capability request routes", () => {
  test("mounted routes resolve to the catalog capabilities the browser declares", async () => {
    const index = buildCapabilityIndex(await loadCapabilityEndpoints());
    // The guard looks a request's capability up by the definition its route
    // mounts, so only a capability whose definition is mounted can match.
    const routed = new Set(
      apiRoutes.flatMap(({ definition }) => {
        const capability = index.get(definition);
        return capability === undefined ? [] : [capability];
      }),
    );

    // An index that recognized nothing would accept no declaration at all.
    expect(routed.size).toBeGreaterThan(100);
    for (const capability of [
      "billing-codes.create",
      "billing-codes.delete",
      "billing-codes.update",
      "chat.threads.update",
    ]) {
      expect(routed.has(capability)).toBe(true);
    }
  });
});
