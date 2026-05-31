import { describe, expect, test } from "bun:test";

import type { AresCompany } from "@stll/business-registries/ares";

import {
  BUSINESS_REGISTRY_DISPATCH,
  executeRegistryLookup,
  getRegistryHandlerByCountry,
  type RegistryHandler,
} from "@/api/lib/business-registries/dispatch";

const ARES_COMPANY_FIXTURE: AresCompany = {
  ico: "27082440",
  name: "Alza.cz a.s.",
  legalForm: "Akciová společnost",
  address: null,
  dateEstablished: null,
  dateRegistered: null,
  czNace: [],
  registryUrl: "https://example.invalid/27082440",
  status: null,
  courtFile: null,
  shareCapital: null,
  statutoryBodies: [{ organName: "Představenstvo", members: [] }],
  actingClause: null,
};

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
        details: { registry: "ares", company: ARES_COMPANY_FIXTURE },
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
      company: ARES_COMPANY_FIXTURE,
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

describe("VIES handler wiring", () => {
  test("is registered under the EU pseudo-jurisdiction", () => {
    const handler = getRegistryHandlerByCountry("EU");
    expect(handler).toBeDefined();
    expect(handler?.slug).toBe("vies");
  });

  test("isCanonicalId accepts well-formed EU VAT numbers", () => {
    const handler = BUSINESS_REGISTRY_DISPATCH.vies;
    expect(handler.isCanonicalId("DE143593636")).toBe(true);
    expect(handler.isCanonicalId(" ie 6388047v ")).toBe(true);
    expect(handler.isCanonicalId("IT00159560366")).toBe(true);
  });

  test("isCanonicalId rejects inputs without a known VAT prefix", () => {
    const handler = BUSINESS_REGISTRY_DISPATCH.vies;
    expect(handler.isCanonicalId("143593636")).toBe(false);
    expect(handler.isCanonicalId("ZZ12345")).toBe(false);
  });

  test("isCanonicalId accepts removed prefixes so lookup can give a tailored error", () => {
    // GB was removed from VIES after Brexit, but the prefix is still
    // a known VAT country — `isCanonicalId` must let it through to the
    // lookup path so `validateVat()` can raise the dedicated
    // "removed after Brexit" ViesValidationError. Returning false
    // here would instead surface the generic "name search not
    // supported" 400.
    const handler = BUSINESS_REGISTRY_DISPATCH.vies;
    expect(handler.isCanonicalId("GB123456789")).toBe(true);
  });

  test("search is null — VIES has no name-search endpoint", () => {
    expect(BUSINESS_REGISTRY_DISPATCH.vies.search).toBeNull();
  });

  test("name search is rejected with a useful error", async () => {
    const result = await executeRegistryLookup({
      handler: BUSINESS_REGISTRY_DISPATCH.vies,
      query: "Acme Corp",
    });
    expect(result).toBeInstanceOf(Error);
    if (result instanceof Error) {
      expect(result.message).toContain("does not support name search");
    }
  });
});
