import { afterEach, describe, expect, test } from "bun:test";

import bankruptFixture from "./__fixtures__/roles-bankrupt.json" with { type: "json" };
import brregFixture from "./__fixtures__/roles-brreg.json" with { type: "json" };
import equinorFixture from "./__fixtures__/roles-equinor.json" with { type: "json" };
import { BrregAPIError, BrregValidationError } from "./errors.js";
import {
  type BrregRawRolesResponse,
  lookupOfficersByOrgnr,
  parseRolesResponse,
} from "./roles.js";

const SKIP_LIVE = process.env["SMOKE_TEST"] !== "1";

// SAFETY: the fixtures are static JSON captured from the live API and
// the runtime types match the file shape; the assertion narrows the
// `unknown` inferred from JSON import attributes.
// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const asResponse = (value: unknown) => value as BrregRawRolesResponse;

const stringifyFetchInput = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
};

const installFetchStub = (
  stub: (url: string) => Promise<Response>,
): (() => void) => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) =>
      stub(stringifyFetchInput(input)),
    { preconnect: original.preconnect },
  );
  return () => {
    globalThis.fetch = original;
  };
};

describe("parseRolesResponse", () => {
  test("flattens role groups and labels roles structurally", () => {
    const officers = parseRolesResponse(asResponse(brregFixture));
    // Brreg's own roster: CEO + auditor entity + public-sector parent.
    expect(officers).toHaveLength(3);
    expect(officers.every((o) => !o.isResigned)).toBe(true);
    expect(officers.map((o) => o.role.code).sort()).toEqual([
      "DAGL",
      "ORGL",
      "REVI",
    ]);
  });

  test("populates `person` for natural persons with a composed name", () => {
    const officers = parseRolesResponse(asResponse(brregFixture));
    const ceo = officers.find((o) => o.role.code === "DAGL");
    expect(ceo?.person?.name).toBe("Inger Lise Strøm");
    expect(ceo?.person?.birthYear).toBe(1971);
    expect(ceo?.person?.isDeceased).toBe(false);
    expect(ceo?.entity).toBeUndefined();
    expect(ceo?.trustee).toBeUndefined();
  });

  test("rejects malformed and future birth years", () => {
    const officers = parseRolesResponse({
      rollegrupper: [
        {
          type: { kode: "STYR" },
          roller: [
            {
              type: { kode: "LEDE" },
              person: {
                fodselsdato: "95",
                navn: { fornavn: "Short", etternavn: "Value" },
              },
            },
            {
              type: { kode: "LEDE" },
              person: {
                fodselsdato: "2999-01-01",
                navn: { fornavn: "Future", etternavn: "Value" },
              },
            },
            {
              type: { kode: "LEDE" },
              person: {
                fodselsdato: "197x-01-01",
                navn: { fornavn: "Partial", etternavn: "Value" },
              },
            },
          ],
        },
      ],
    });
    expect(officers.map((officer) => officer.person?.birthYear)).toEqual([
      null,
      null,
      null,
    ]);
  });

  test("populates `entity` for corporate role holders", () => {
    const officers = parseRolesResponse(asResponse(brregFixture));
    const auditor = officers.find((o) => o.role.code === "REVI");
    expect(auditor?.entity?.orgnr).toBe("974760843");
    expect(auditor?.entity?.name).toBe("RIKSREVISJONEN");
    expect(auditor?.person).toBeUndefined();
  });

  test("includes mellomnavn in composed person name when present", () => {
    const officers = parseRolesResponse(asResponse(equinorFixture));
    const employeeRep = officers.find(
      (o) => o.person?.name === "Frank Indreland Gundersen",
    );
    expect(employeeRep).toBeDefined();
  });

  test("propagates the role group's sistEndret as changedAt", () => {
    const officers = parseRolesResponse(asResponse(brregFixture));
    const ceo = officers.find((o) => o.role.code === "DAGL");
    expect(ceo?.changedAt).toBe("2026-04-13");
  });

  test("marks resigned officers via isResigned and keeps them in the list", () => {
    const officers = parseRolesResponse(asResponse(bankruptFixture));
    // Bankrupt entity: one trustee (active) + two resigned officers.
    const resigned = officers.filter((o) => o.isResigned);
    const active = officers.filter((o) => !o.isResigned);
    expect(resigned.length).toBeGreaterThan(0);
    expect(active.length).toBeGreaterThan(0);
    // Resigned officers are NOT silently dropped — they remain in the
    // payload labelled with isResigned so callers can render "former".
    expect(officers.length).toBe(resigned.length + active.length);
  });

  test("populates `trustee` for bostyrer roles", () => {
    const officers = parseRolesResponse(asResponse(bankruptFixture));
    const trustee = officers.find((o) => o.role.code === "BOBE");
    expect(trustee?.trustee?.name).toContain("Bovim");
    expect(trustee?.trustee?.postalAddress).toContain("BERGEN");
    expect(trustee?.person).toBeUndefined();
    expect(trustee?.entity).toBeUndefined();
  });

  test("returns an empty list for a payload with no role groups", () => {
    expect(parseRolesResponse({})).toEqual([]);
    expect(parseRolesResponse({ rollegrupper: [] })).toEqual([]);
  });
});

describe("lookupOfficersByOrgnr validation", () => {
  test("throws BrregValidationError for malformed input", () => {
    expect(lookupOfficersByOrgnr("12345678")).rejects.toBeInstanceOf(
      BrregValidationError,
    );
  });

  test("throws BrregValidationError for bad checksum", () => {
    expect(lookupOfficersByOrgnr("974760674")).rejects.toBeInstanceOf(
      BrregValidationError,
    );
  });
});

describe("lookupOfficersByOrgnr fetch", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test("returns the parsed officer roster for a 200 response", async () => {
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(brregFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const officers = await lookupOfficersByOrgnr("974760673");
    expect(officers).toHaveLength(3);
    expect(officers.find((o) => o.role.code === "DAGL")?.person?.name).toBe(
      "Inger Lise Strøm",
    );
  });

  test("returns [] when the orgnr is unknown (404)", async () => {
    restore = installFetchStub(async () => new Response(null, { status: 404 }));
    expect(await lookupOfficersByOrgnr("974760673")).toEqual([]);
  });

  test("returns [] when the upstream returns 410 Gone", async () => {
    restore = installFetchStub(async () => new Response(null, { status: 410 }));
    expect(await lookupOfficersByOrgnr("974760673")).toEqual([]);
  });

  test("preserves API status when non-JSON error bodies are returned", () => {
    restore = installFetchStub(
      async () =>
        new Response("<html>bad gateway</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
    );
    expect(lookupOfficersByOrgnr("974760673")).rejects.toMatchObject({
      name: "BrregAPIError",
      httpStatus: 502,
      upstreamMessage: null,
    });
  });

  test("surfaces malformed 200 JSON as BrregAPIError", () => {
    restore = installFetchStub(
      async () =>
        new Response("{", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    expect(lookupOfficersByOrgnr("974760673")).rejects.toBeInstanceOf(
      BrregAPIError,
    );
  });

  test("normalises spaces and dashes before hitting the API", async () => {
    let observedUrl = "";
    restore = installFetchStub(async (url) => {
      observedUrl = url;
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    await lookupOfficersByOrgnr("974 760 673");
    expect(observedUrl).toBe(
      "https://data.brreg.no/enhetsregisteret/api/enheter/974760673/roller",
    );
  });
});

// Live tests hit the real Brreg open API. They double as integration tests
// and document the expected response shape for known entities.
describe.skipIf(SKIP_LIVE)("lookupOfficersByOrgnr live", () => {
  test("returns the registry's own officer roster", async () => {
    const officers = await lookupOfficersByOrgnr("974760673");
    expect(officers.length).toBeGreaterThan(0);
    expect(officers.some((o) => o.role.code === "DAGL")).toBe(true);
  });

  test("returns [] for a checksum-valid but non-existent orgnr", async () => {
    const officers = await lookupOfficersByOrgnr("100000008");
    expect(officers).toEqual([]);
  });
});
