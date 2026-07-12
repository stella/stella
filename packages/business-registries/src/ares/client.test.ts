import { afterEach, describe, expect, test } from "bun:test";

import { lookupByIco, searchByName } from "./client.js";
import { AresValidationError } from "./errors.js";

const SKIP_LIVE = process.env["SMOKE_TEST"] !== "1";

type SearchRequestCapture = {
  pocet: unknown;
};

const captureSearchRequest = (): {
  captured: SearchRequestCapture;
  restore: () => void;
} => {
  const captured: SearchRequestCapture = { pocet: undefined };
  const originalFetch = globalThis.fetch;
  const stub = async (
    _input: URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawBody = typeof init?.body === "string" ? init.body : "{}";
    const payload =
      // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- request body built by client.ts's own JSON.stringify(payload); shape asserted by the expectations below
      JSON.parse(rawBody) as Record<string, unknown>;
    captured.pocet = payload["pocet"];
    return new Response(
      JSON.stringify({ pocetCelkem: 0, ekonomickeSubjekty: [] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  globalThis.fetch = Object.assign(stub, {
    preconnect: originalFetch.preconnect,
  });
  return {
    captured,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

// These tests hit the real ARES API. They serve as integration tests
// and also document the expected response shape for known subjects.
describe.skipIf(SKIP_LIVE)("lookupByIco live", () => {
  test("returns full company data for a known IČO", async () => {
    const result = await lookupByIco("27082440"); // Alza.cz a.s.

    expect(result).not.toBeNull();
    expect(result?.ico).toBe("27082440");
    expect(result?.name).toContain("Alza");
    expect(result?.address).not.toBeNull();
    expect(result?.address?.municipality).toBeTruthy();
    expect(result?.registryUrl).toContain("27082440");
    expect(result?.czNace.length).toBeGreaterThan(0);
  });

  test("returns VR-enriched data by default", async () => {
    const result = await lookupByIco("27082440");

    expect(result).not.toBeNull();
    // VR fields should be present for a joint-stock company
    expect(result?.courtFile).not.toBeNull();
    expect(result?.statutoryBodies.length).toBeGreaterThan(0);
  });

  test("skips VR when includeVr is false", async () => {
    const result = await lookupByIco("27082440", { includeVr: false });

    expect(result).not.toBeNull();
    expect(result?.ico).toBe("27082440");
    // VR fields should be empty when not fetched
    expect(result?.courtFile).toBeNull();
    expect(result?.statutoryBodies).toEqual([]);
  });

  test("returns null for a non-existent IČO", async () => {
    // Valid checksum but does not exist in ARES
    const result = await lookupByIco("99999994");
    expect(result).toBeNull();
  });

  test("handles IČO with leading zeros (ČEZ)", async () => {
    const result = await lookupByIco("00027383");

    expect(result).not.toBeNull();
    expect(result?.name).toBeTruthy();
  });
});

describe("lookupByIco validation", () => {
  test("throws AresValidationError for invalid IČO", async () => {
    expect(lookupByIco("12345678")).rejects.toBeInstanceOf(AresValidationError);
  });

  test("rejects short IČO without leading zeros", async () => {
    expect(lookupByIco("27383")).rejects.toBeInstanceOf(AresValidationError);
  });
});

describe.skipIf(SKIP_LIVE)("searchByName live", () => {
  test("finds companies by name", async () => {
    const results = await searchByName("Alza.cz");

    expect(results.length).toBeGreaterThan(0);
    const alza = results.find((r) => r.ico === "27082440");
    expect(alza).toBeTruthy();
    expect(alza?.name).toContain("Alza");
  });

  test("returns empty array for unknown name", async () => {
    const results = await searchByName("xyznonexistent12345");
    expect(results).toEqual([]);
  });

  test("respects limit option", async () => {
    const results = await searchByName("Alza.cz", { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

describe("searchByName validation", () => {
  test("throws AresValidationError for empty name", async () => {
    expect(searchByName("")).rejects.toBeInstanceOf(AresValidationError);
    expect(searchByName("   ")).rejects.toBeInstanceOf(AresValidationError);
  });
});

describe("searchByName limit clamping", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test("defaults pocet to 50 when no limit is given", async () => {
    const ctx = captureSearchRequest();
    restore = ctx.restore;

    await searchByName("Alza");
    expect(ctx.captured.pocet).toBe(50);
  });

  test("forwards an in-range limit unchanged", async () => {
    const ctx = captureSearchRequest();
    restore = ctx.restore;

    await searchByName("Alza", { limit: 3 });
    expect(ctx.captured.pocet).toBe(3);
  });

  test("clamps a limit above the ceiling to 100", async () => {
    const ctx = captureSearchRequest();
    restore = ctx.restore;

    await searchByName("Alza", { limit: 5000 });
    expect(ctx.captured.pocet).toBe(100);
  });

  test("clamps a non-positive limit up to 1", async () => {
    const ctx = captureSearchRequest();
    restore = ctx.restore;

    await searchByName("Alza", { limit: 0 });
    expect(ctx.captured.pocet).toBe(1);
  });
});
