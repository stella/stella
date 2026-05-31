import { afterEach, describe, expect, test } from "bun:test";

import { lookupBySiren, lookupBySiret, searchByName } from "./client.js";
import {
  RechercheEntreprisesAPIError,
  RechercheEntreprisesValidationError,
} from "./errors.js";
import type { RechercheEntreprisesSearchResponse } from "./types.js";

const SKIP_LIVE = process.env["SMOKE_TEST"] !== "1";

const FIXTURE_DIR = new URL("__fixtures__/", import.meta.url);
const readFixture = async (
  name: string,
): Promise<RechercheEntreprisesSearchResponse> => {
  const value: unknown = await Bun.file(new URL(name, FIXTURE_DIR)).json();
  // SAFETY: fixtures are captured directly from the live API and
  // committed alongside the tests; runtime validation here would only
  // catch drift between an upstream payload and the committed JSON,
  // which is precisely what the assertions below check anyway.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return value as RechercheEntreprisesSearchResponse;
};

const installFetchStub = (
  handler: (input: URL | Request | string) => Promise<Response>,
) => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: URL | Request | string) => handler(input),
    { preconnect: original.preconnect },
  );
  return () => {
    globalThis.fetch = original;
  };
};

// ---------------------------------------------------------------------------
// Live tests — opt-in. Mirrors the PRH / Brreg pattern.
// ---------------------------------------------------------------------------
describe.skipIf(SKIP_LIVE)("lookupBySiren live", () => {
  test("returns RENAULT SAS", async () => {
    const result = await lookupBySiren("780129987");
    expect(result).not.toBeNull();
    expect(result?.siren).toBe("780129987");
    expect(result?.name.toUpperCase()).toContain("RENAULT");
    expect(result?.registryUrl).toContain("780129987");
  });
});

describe.skipIf(SKIP_LIVE)("lookupBySiret live", () => {
  test("returns RENAULT SAS head office", async () => {
    const result = await lookupBySiret("78012998704037");
    expect(result).not.toBeNull();
    expect(result?.siren).toBe("780129987");
    expect(result?.matchedEstablishment?.siret).toBe("78012998704037");
  });
});

describe.skipIf(SKIP_LIVE)("searchByName live", () => {
  test("finds RENAULT entities", async () => {
    const results = await searchByName("Renault", { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.some((entry) => entry.name.toUpperCase().includes("RENAULT")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mocked fetch tests using captured upstream fixtures.
// ---------------------------------------------------------------------------
describe("lookupBySiren (fixture)", () => {
  let restore: () => void = () => {
    // noop until installFetchStub assigns a real teardown
  };
  afterEach(() => {
    restore();
    restore = () => {
      // noop
    };
  });

  test("parses the live RENAULT SAS SIREN payload", async () => {
    const body = await readFixture("lookup-siren-renault.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const company = await lookupBySiren("780129987");
    expect(company).not.toBeNull();
    expect(company?.siren).toBe("780129987");
    expect(company?.name).toBe("RENAULT SAS");
    expect(company?.status).toEqual({ type: "active" });
    expect(company?.legalFormCode).toBe("5710");
    expect(company?.headOffice?.siret).toBe("78012998704037");
    expect(company?.headOffice?.isHeadOffice).toBe(true);
    expect(company?.headOffice?.status).toEqual({ type: "open" });
    expect(company?.registryUrl).toBe(
      "https://annuaire-entreprises.data.gouv.fr/entreprise/780129987",
    );
    // SIREN lookups must not populate matchedEstablishment.
    expect(company?.matchedEstablishment).toBeNull();
  });

  test("returns null when total_results is 0", async () => {
    const body = await readFixture("lookup-not-found.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    expect(await lookupBySiren("837295260")).toBeNull();
  });

  test("returns null when the first result's siren does not match", async () => {
    // Defence-in-depth: upstream `q=` is a multi-field substring
    // search. A SIREN that does not match any unité légale but is a
    // substring of e.g. a phone number could in principle return a
    // different entity. The parser must require an exact SIREN match
    // before surfacing the hit.
    const body = await readFixture("lookup-siren-renault.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    expect(await lookupBySiren("552032534")).toBeNull();
  });

  test("surfaces 5xx errors as RechercheEntreprisesAPIError", async () => {
    restore = installFetchStub(
      async () =>
        new Response(
          JSON.stringify({
            message: "Service temporarily unavailable",
          }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
    );
    expect(lookupBySiren("780129987")).rejects.toMatchObject({
      name: "RechercheEntreprisesAPIError",
      httpStatus: 503,
      upstreamMessage: "Service temporarily unavailable",
    });
  });

  test("translates an unparseable 200 body into RechercheEntreprisesAPIError", async () => {
    // A 200 with truncated JSON would otherwise bubble out as a bare
    // SyntaxError, bypass dispatch.ts's mapRechercheEntreprisesError,
    // and surface as HTTP 500. Translate it the same way 5xx is.
    restore = installFetchStub(
      async () =>
        new Response("{ not json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    expect(lookupBySiren("780129987")).rejects.toMatchObject({
      name: "RechercheEntreprisesAPIError",
      httpStatus: 200,
    });
  });
});

describe("lookupBySiret (fixture)", () => {
  let restore: () => void = () => {
    // noop until installFetchStub assigns a real teardown
  };
  afterEach(() => {
    restore();
    restore = () => {
      // noop
    };
  });

  test("parses the live RENAULT SAS SIRET payload", async () => {
    const body = await readFixture("lookup-siret-renault.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const company = await lookupBySiret("78012998704037");
    expect(company).not.toBeNull();
    expect(company?.siren).toBe("780129987");
    expect(company?.matchedEstablishment?.siret).toBe("78012998704037");
    expect(company?.matchedEstablishment?.isHeadOffice).toBe(true);
  });

  test("returns null when the SIRET is not in matching_etablissements", async () => {
    // Upstream `q=` is a fuzzy multi-field search, so a request for a
    // non-existent NIC under a real SIREN still resolves the parent
    // unité légale. Without the establishment-exact check, the
    // adapter would falsely report the parent company as the
    // requested establishment. Pin the contract.
    const body = await readFixture("lookup-siret-renault.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    // SIREN 780129987 (Renault) + NIC 99999 + Luhn check digit 5 =
    // 78012998799995, a Luhn-valid SIRET that does not appear in the
    // Renault fixture's matching_etablissements list.
    const company = await lookupBySiret("78012998799995");
    expect(company).toBeNull();
  });
});

describe("searchByName (fixture)", () => {
  let restore: () => void = () => {
    // noop until installFetchStub assigns a real teardown
  };
  afterEach(() => {
    restore();
    restore = () => {
      // noop
    };
  });

  test("parses the live Renault search page", async () => {
    const body = await readFixture("search-renault.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const results = await searchByName("Renault");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((entry) => /^\d{9}$/u.test(entry.siren))).toBe(true);
  });

  test("applies the limit option client-side", async () => {
    const body = await readFixture("search-renault.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const results = await searchByName("Renault", { limit: 1 });
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
describe("lookupBySiren validation", () => {
  test("rejects format violations", () => {
    expect(lookupBySiren("12345")).rejects.toBeInstanceOf(
      RechercheEntreprisesValidationError,
    );
    expect(lookupBySiren("abcdefghi")).rejects.toBeInstanceOf(
      RechercheEntreprisesValidationError,
    );
  });

  test("rejects bad checksum", () => {
    // 780129987 is the genuine SIREN; bumping the last digit must fail.
    expect(lookupBySiren("780129988")).rejects.toBeInstanceOf(
      RechercheEntreprisesValidationError,
    );
  });
});

describe("lookupBySiret validation", () => {
  test("rejects format violations", () => {
    expect(lookupBySiret("12345")).rejects.toBeInstanceOf(
      RechercheEntreprisesValidationError,
    );
    expect(lookupBySiret("780129987")).rejects.toBeInstanceOf(
      RechercheEntreprisesValidationError,
    );
  });

  test("rejects bad checksum", () => {
    expect(lookupBySiret("78012998704038")).rejects.toBeInstanceOf(
      RechercheEntreprisesValidationError,
    );
  });
});

describe("searchByName validation", () => {
  test("rejects empty input", () => {
    expect(searchByName("")).rejects.toBeInstanceOf(
      RechercheEntreprisesValidationError,
    );
    expect(searchByName("  ")).rejects.toBeInstanceOf(
      RechercheEntreprisesValidationError,
    );
  });
});

// Smoke: error class export is reachable via barrel for consumers
// that only import from the package root.
test("exports RechercheEntreprisesAPIError", () => {
  expect(RechercheEntreprisesAPIError).toBeDefined();
});
