import { describe, expect, test } from "bun:test";

import { buildCapabilityRouteIndex } from "@/api/lib/capability-request";
import { loadCapabilityEndpoints } from "@/api/lib/capability-request-endpoints";
import api from "@/api/server";

describe("capability request routes", () => {
  test("mounted routes resolve to the catalog capabilities the browser declares", async () => {
    const index = buildCapabilityRouteIndex({
      routes: api.routes,
      endpoints: await loadCapabilityEndpoints(),
    });
    const routed = new Set(index.values());

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
