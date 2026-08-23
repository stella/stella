import { describe, expect, test } from "bun:test";

import type { LookupOutcome } from "@/api/lib/docx/lookup-fields";

import { createLookupPreviewCache } from "./lookup-preview-cache";

describe("lookup preview cache", () => {
  test("does not repopulate after eviction while a lookup is pending", async () => {
    const pending = Promise.withResolvers<LookupOutcome>();
    const cache = createLookupPreviewCache();
    let loads = 0;

    const firstLookup = cache.getOrLoad({
      key: "registry:number",
      load: async () => {
        loads += 1;
        return pending.promise;
      },
    });

    expect(cache.clear()).toBe(0);
    pending.resolve({ type: "not-found" });
    await firstLookup;

    await cache.getOrLoad({
      key: "registry:number",
      load: async () => {
        loads += 1;
        return { type: "not-found" };
      },
    });

    expect(loads).toBe(2);
  });
});
