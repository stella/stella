import { afterEach, describe, expect, test } from "bun:test";

import { validateVat } from "./client.js";
import { ViesAPIError, ViesValidationError } from "./errors.js";
import type { ViesRawResponse } from "./types.js";

const SKIP_LIVE = process.env["SMOKE_TEST"] !== "1";

const FIXTURE_DIR = new URL("__fixtures__/", import.meta.url);
const readFixture = async (name: string): Promise<ViesRawResponse> => {
  const value: unknown = await Bun.file(new URL(name, FIXTURE_DIR)).json();
  // SAFETY: fixtures are captured directly from the live VIES REST
  // API and committed alongside the tests; runtime validation would
  // only catch drift between the upstream payload and the committed
  // JSON, which the assertions below cover.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return value as ViesRawResponse;
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
// Live tests — opt-in. Mirror the brreg / prh patterns.
// ---------------------------------------------------------------------------
describe.skipIf(SKIP_LIVE)("validateVat live", () => {
  test("returns valid for Google Ireland (IE6388047V)", async () => {
    const result = await validateVat("IE6388047V");
    expect(result.valid).toBe(true);
    expect(result.status).toEqual({ type: "valid" });
    expect(result.vatNumber).toEqual({ country: "IE", vat: "6388047V" });
    expect(result.name?.toUpperCase()).toContain("GOOGLE");
  });

  test("returns not-registered for an unregistered DE number", async () => {
    const result = await validateVat("DE000000000");
    expect(result.valid).toBe(false);
    expect(result.status.type).not.toBe("valid");
  });
});

// ---------------------------------------------------------------------------
// Mocked fetch tests using captured upstream fixtures.
// ---------------------------------------------------------------------------
describe("validateVat (fixture)", () => {
  let restore: () => void = () => {
    // noop until installFetchStub assigns a real teardown
  };
  afterEach(() => {
    restore();
    restore = () => {
      // noop
    };
  });

  test("parses a VALID Italian record (Ferrari S.p.A.)", async () => {
    const body = await readFixture("check-it-ferrari.json");
    restore = installFetchStub(async (input) => {
      let url: string;
      if (typeof input === "string") {
        url = input;
      } else if (input instanceof URL) {
        url = input.href;
      } else {
        url = input.url;
      }
      expect(url).toContain("/ms/IT/vat/00159560366");
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await validateVat("IT00159560366");
    expect(result.valid).toBe(true);
    expect(result.status).toEqual({ type: "valid" });
    expect(result.name).toBe("FERRARI S.P.A.");
    expect(result.address).toContain("MODENA");
    expect(result.vatNumber).toEqual({ country: "IT", vat: "00159560366" });
  });

  test("parses a VALID Irish record (Google Ireland)", async () => {
    const body = await readFixture("check-ie-google.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const result = await validateVat("IE6388047V");
    expect(result.valid).toBe(true);
    expect(result.name).toBe("GOOGLE IRELAND LIMITED");
    expect(result.address).toContain("DUBLIN");
  });

  test("normalises '---' name/address for data-protected member states (DE)", async () => {
    const body = await readFixture("check-de-data-protected.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const result = await validateVat("DE811569869");
    expect(result.valid).toBe(true);
    expect(result.name).toBeNull();
    expect(result.address).toBeNull();
  });

  test("maps INVALID (well-formed but unregistered) to not-registered", async () => {
    const body = await readFixture("check-de-not-found.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const result = await validateVat("DE000000000");
    expect(result.valid).toBe(false);
    expect(result.status).toEqual({ type: "not-registered" });
  });

  test("maps short / malformed inputs that upstream rejects to not-registered", async () => {
    // The REST endpoint rolls all rejection variants (well-formed but
    // unregistered, non-numeric, too-short, …) into `userError:
    // "INVALID"`. The fixture below was captured from a literal "ABC"
    // submitted to the DE endpoint; the structured outcome we surface
    // is `not-registered`, since the VIES POST endpoint's separate
    // `INVALID_INPUT` flavour does not appear here. The `invalid-format`
    // branch is still exercised through parse.test.ts using a
    // hand-built upstream payload, since it remains a documented
    // upstream verdict.
    const body = await readFixture("check-invalid-short.json");
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const result = await validateVat("DE123456789");
    expect(result.valid).toBe(false);
    expect(result.status).toEqual({ type: "not-registered" });
  });

  test("surfaces upstream non-2xx as ViesAPIError", async () => {
    restore = installFetchStub(
      async () => new Response("Bad Gateway", { status: 502 }),
    );

    expect(validateVat("IE6388047V")).rejects.toMatchObject({
      name: "ViesAPIError",
      httpStatus: 502,
    });
  });

  test("rejects responses that fail shape detection", async () => {
    restore = installFetchStub(
      async () =>
        new Response(JSON.stringify({ unexpected: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    expect(validateVat("IE6388047V")).rejects.toMatchObject({
      name: "ViesAPIError",
    });
  });
});

// ---------------------------------------------------------------------------
// Pre-flight validation
// ---------------------------------------------------------------------------
describe("validateVat pre-flight validation", () => {
  test("throws ViesValidationError when no country prefix is present", () => {
    expect(validateVat("143593636")).rejects.toBeInstanceOf(
      ViesValidationError,
    );
  });

  test("throws ViesValidationError for unknown country prefix", () => {
    expect(validateVat("ZZ123456789")).rejects.toBeInstanceOf(
      ViesValidationError,
    );
  });

  test("throws ViesValidationError for GB (removed from VIES)", () => {
    expect(validateVat("GB123456789")).rejects.toBeInstanceOf(
      ViesValidationError,
    );
  });
});

// Smoke: ViesAPIError reachable via barrel for consumers that only
// import from the package root.
test("exports ViesAPIError", () => {
  expect(ViesAPIError).toBeDefined();
});
