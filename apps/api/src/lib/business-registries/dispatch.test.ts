import { describe, expect, test } from "bun:test";

import {
  AresRequestError,
  type AresCompany,
} from "@stll/business-registries/ares";

import { env } from "@/api/env";
import {
  BUSINESS_REGISTRY_DISPATCH,
  executeRegistryLookup,
  getRegistryHandlerByCountry,
  isBusinessRegistryNativeToolDeployAvailable,
  registryDisabledForOrgRefusal,
  type RegistryHandler,
} from "@/api/lib/business-registries/dispatch";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

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
  vrEnrichmentStatus: "complete",
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

  test("maps ARES transport failures to a sanitized retryable-upstream tag", async () => {
    const cause = new AresRequestError(
      "https://ares.example.invalid/private-path",
      "sensitive transport detail",
    );
    const result = await executeRegistryLookup({
      handler: stubHandler({
        lookup: async () => {
          throw cause;
        },
      }),
      query: "27082440",
    });

    expect(result).toMatchObject({
      code: "upstream_unavailable",
      status: 502,
      message: "ARES is temporarily unavailable",
      cause,
    });
    if (!(result instanceof Error)) {
      throw new TypeError("expected a mapped HandlerError");
    }
    expect(result.message).not.toContain("sensitive transport detail");
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
    expect(handler.isCanonicalId("RO12")).toBe(true);
  });

  test("isCanonicalId rejects inputs without a known VAT prefix", () => {
    const handler = BUSINESS_REGISTRY_DISPATCH.vies;
    expect(handler.isCanonicalId("143593636")).toBe(false);
    expect(handler.isCanonicalId("ZZ12345")).toBe(false);
  });

  test("isCanonicalId rejects ordinary names that start with VAT prefixes", () => {
    const handler = BUSINESS_REGISTRY_DISPATCH.vies;
    expect(handler.isCanonicalId("Deutsche Bank")).toBe(false);
  });

  test("isCanonicalId routes malformed numeric VATs to validation", () => {
    const handler = BUSINESS_REGISTRY_DISPATCH.vies;
    expect(handler.isCanonicalId("DE123")).toBe(true);
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

describe("Companies House hit address", () => {
  // Exercises `companiesHouseCompanyToHit`'s line1 composition via
  // the dispatch lookup path. Downstream consumers (the contact-form
  // `toBillingAddress` mapper in apps/web) prefer the structured
  // address fields before falling back to `textAddress`, so c/o +
  // PO box need to appear in `line1` too — not just in `textAddress`.
  const stubCompaniesHouseFetch = (body: unknown): (() => void) => {
    const original = globalThis.fetch;
    const stub = async (): Promise<Response> =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    globalThis.fetch = Object.assign(stub, {
      preconnect: original.preconnect,
    });
    return (): void => {
      globalThis.fetch = original;
    };
  };

  test("prepends care_of and po_box to line1 for agent-held addresses", async () => {
    const previous = process.env["COMPANIES_HOUSE_API_KEY"];
    process.env["COMPANIES_HOUSE_API_KEY"] = "test-key";
    const restore = stubCompaniesHouseFetch({
      company_name: "ACME SECRETARIAT LTD",
      company_number: "12345678",
      company_status: "active",
      type: "ltd",
      jurisdiction: "england-wales",
      date_of_creation: "2010-01-01",
      registered_office_address: {
        care_of: "Acme Secretaries Limited",
        po_box: "5000",
        address_line_1: "1 Imaginary Street",
        locality: "London",
        postal_code: "EC1A 1AA",
        country: "United Kingdom",
      },
    });
    try {
      const handler = BUSINESS_REGISTRY_DISPATCH["companies-house"];
      const hit = await handler.lookup("12345678");
      expect(hit?.address?.line1).toBe(
        "c/o Acme Secretaries Limited PO Box 5000 1 Imaginary Street",
      );
    } finally {
      restore();
      if (previous === undefined) {
        delete process.env["COMPANIES_HOUSE_API_KEY"];
      } else {
        process.env["COMPANIES_HOUSE_API_KEY"] = previous;
      }
    }
  });
});

describe("EDGAR deployment gating", () => {
  test("does not expose the US handler when EDGAR_USER_AGENT is missing", () => {
    const previous = process.env["EDGAR_USER_AGENT"];
    delete process.env["EDGAR_USER_AGENT"];
    try {
      expect(getRegistryHandlerByCountry("US")).toBeUndefined();
      expect(isBusinessRegistryNativeToolDeployAvailable("edgar")).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env["EDGAR_USER_AGENT"];
      } else {
        process.env["EDGAR_USER_AGENT"] = previous;
      }
    }
  });

  test("exposes the US handler when EDGAR_USER_AGENT is configured", () => {
    const previous = process.env["EDGAR_USER_AGENT"];
    process.env["EDGAR_USER_AGENT"] = "Stella stella@example.com";
    try {
      expect(getRegistryHandlerByCountry("US")?.slug).toBe("edgar");
      expect(isBusinessRegistryNativeToolDeployAvailable("edgar")).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env["EDGAR_USER_AGENT"];
      } else {
        process.env["EDGAR_USER_AGENT"] = previous;
      }
    }
  });
});

describe("DENUE deployment gating", () => {
  test("normalizes lookup hits and preserves the DENUE enrichment payload", async () => {
    const previousToken = process.env["INEGI_DENUE_API_TOKEN"];
    const originalFetch = globalThis.fetch;
    process.env["INEGI_DENUE_API_TOKEN"] = "test-token";
    const stub = async (): Promise<Response> =>
      new Response(
        JSON.stringify([
          {
            Id: "6281106",
            Nombre: "HOTEL MARRIOTT REFORMA",
            Razon_social: "HOTELERA REFORMA SA DE CV",
            Tipo_vialidad: "AVENIDA",
            Calle: "PASEO DE LA REFORMA",
            Num_Exterior: "276",
            CP: "06600",
            Ubicacion: "LOCALIDAD, MUNICIPIO, ESTADO",
            Latitud: "19.428611",
            Longitud: "-99.162222",
          },
        ]),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    globalThis.fetch = Object.assign(stub, {
      preconnect: originalFetch.preconnect,
    });
    try {
      const hit = await BUSINESS_REGISTRY_DISPATCH.denue.lookup("6281106");
      expect(hit?.registry).toBe("denue");
      expect(hit?.legalForm).toBeNull();
      expect(hit?.address?.city).toBe("MUNICIPIO");
      expect(hit?.address?.region).toBe("ESTADO");
      expect(hit?.details).toEqual({
        registry: "denue",
        establishment: expect.objectContaining({
          id: "6281106",
          legalName: "HOTELERA REFORMA SA DE CV",
        }),
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (previousToken === undefined) {
        delete process.env["INEGI_DENUE_API_TOKEN"];
      } else {
        process.env["INEGI_DENUE_API_TOKEN"] = previousToken;
      }
    }
  });

  test("does not expose the MX handler when INEGI_DENUE_API_TOKEN is missing", () => {
    const previous = process.env["INEGI_DENUE_API_TOKEN"];
    delete process.env["INEGI_DENUE_API_TOKEN"];
    try {
      expect(getRegistryHandlerByCountry("MX")).toBeUndefined();
      expect(isBusinessRegistryNativeToolDeployAvailable("denue")).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env["INEGI_DENUE_API_TOKEN"];
      } else {
        process.env["INEGI_DENUE_API_TOKEN"] = previous;
      }
    }
  });

  test("exposes the MX handler when INEGI_DENUE_API_TOKEN is configured", () => {
    const previous = process.env["INEGI_DENUE_API_TOKEN"];
    process.env["INEGI_DENUE_API_TOKEN"] = "test-token";
    try {
      expect(getRegistryHandlerByCountry("MX")?.slug).toBe("denue");
      expect(isBusinessRegistryNativeToolDeployAvailable("denue")).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env["INEGI_DENUE_API_TOKEN"];
      } else {
        process.env["INEGI_DENUE_API_TOKEN"] = previous;
      }
    }
  });
});

describe("executeRegistryLookup — canonical-id guard", () => {
  test("maps an isCanonicalId failure to a handler error instead of throwing", async () => {
    const result = await executeRegistryLookup({
      handler: stubHandler({
        isCanonicalId: () => {
          throw new Error("native binding unavailable");
        },
      }),
      query: "27082440",
    });

    if (!(result instanceof HandlerError)) {
      throw new TypeError("expected a handler error");
    }
    expect(result.status).toBe(500);
  });
});

describe("registryDisabledForOrgRefusal", () => {
  const catalogueUrl = `${env.FRONTEND_URL.replace(/\/$/u, "")}/knowledge/tools?slug=krs`;

  test("names the catalogue link and the jurisdiction that would enable it", () => {
    const refusal = registryDisabledForOrgRefusal({
      registry: "krs",
      reason: "jurisdiction_mismatch",
    });

    expect(refusal.message).toBe(
      `The KRS registry is disabled for this organization. An organization ` +
        `admin can enable it at ${catalogueUrl}, or add Poland to the ` +
        `practice jurisdictions.`,
    );
    expect(refusal.hint).toBe(
      `Ask an organization admin to enable KRS at ${catalogueUrl}, or to add ` +
        `Poland to the practice jurisdictions. It cannot be enabled from the ` +
        `client.`,
    );
  });

  test("offers only the catalogue link when an explicit override turned it off", () => {
    // Adding the jurisdiction would not clear an explicit `false` override, so
    // the refusal must not promise that it would.
    const refusal = registryDisabledForOrgRefusal({
      registry: "krs",
      reason: "disabled_by_override",
    });

    expect(refusal.message).toBe(
      `The KRS registry is disabled for this organization. An organization ` +
        `admin can enable it at ${catalogueUrl}.`,
    );
    expect(refusal.message).not.toContain("practice jurisdictions");
  });

  test("asks for an EU member state where the catalogue recommends the EU", () => {
    expect(
      registryDisabledForOrgRefusal({
        registry: "vies",
        reason: "jurisdiction_mismatch",
      }).message,
    ).toContain("add an EU member state to the practice jurisdictions");
  });
});
