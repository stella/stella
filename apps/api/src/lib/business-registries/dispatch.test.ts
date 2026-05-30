import { describe, expect, test } from "bun:test";

import {
  BUSINESS_REGISTRY_DISPATCH,
  executeRegistryLookup,
  type RegistryHandler,
} from "@/api/lib/business-registries/dispatch";

const stubHandler = (
  override: Partial<RegistryHandler> = {},
): RegistryHandler => ({
  ...BUSINESS_REGISTRY_DISPATCH.ares,
  ...override,
});

describe("executeRegistryLookup — details channel", () => {
  test("lookup hits carry adapter-specific enrichment payload", async () => {
    const handler = stubHandler({
      isCanonicalId: () => true,
      lookup: async () => ({
        registry: "ares",
        id: "27082440",
        name: "Alza.cz a.s.",
        legalForm: "Akciová společnost",
        address: null,
        registryUrl: "https://example.invalid/27082440",
        details: {
          registry: "ares",
          // Cast: this is a stubbed minimal AresCompany shape sufficient
          // to verify the dispatch propagates `details`. The full type
          // is exercised by the adapter package's own tests.
          // SAFETY: stub-only — narrower than AresCompany on purpose,
          // we only care that the field round-trips through dispatch.
          company: {
            ico: "27082440",
            name: "Alza.cz a.s.",
            statutoryBodies: [{ organName: "Představenstvo", members: [] }],
          } as never,
        },
      }),
    });

    const result = await executeRegistryLookup({
      handler,
      query: "27082440",
    });

    if (result instanceof Error) {
      throw new TypeError(`unexpected handler error: ${result.message}`);
    }
    if (result.type !== "lookup") {
      throw new Error(`expected lookup result, got ${result.type}`);
    }
    expect(result.hit?.details).toEqual({
      registry: "ares",
      company: {
        ico: "27082440",
        name: "Alza.cz a.s.",
        statutoryBodies: [{ organName: "Představenstvo", members: [] }],
      } as never,
    });
  });

  test("search hits do not carry a details payload", async () => {
    const handler = stubHandler({
      isCanonicalId: () => false,
      search: async () => [
        {
          registry: "ares",
          id: "27082440",
          name: "Alza.cz a.s.",
          legalForm: null,
          address: null,
          registryUrl: "https://example.invalid/27082440",
        },
      ],
    });

    const result = await executeRegistryLookup({
      handler,
      query: "Alza",
    });

    if (result instanceof Error) {
      throw new TypeError(`unexpected handler error: ${result.message}`);
    }
    if (result.type !== "search") {
      throw new Error(`expected search result, got ${result.type}`);
    }
    expect(result.hits[0]?.details).toBeUndefined();
  });
});
