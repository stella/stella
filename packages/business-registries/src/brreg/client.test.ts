import { afterEach, describe, expect, test } from "bun:test";

import { lookupByOrgnr, searchByName } from "./client.js";
import { BrregTooBroadError, BrregValidationError } from "./errors.js";

const SKIP_LIVE = process.env["SMOKE_TEST"] !== "1";

// Live tests hit the real Brreg open API. They double as integration tests
// and document the expected response shape for known entities.
describe.skipIf(SKIP_LIVE)("lookupByOrgnr live", () => {
  test("returns the registry itself", async () => {
    const result = await lookupByOrgnr("974760673");
    expect(result).not.toBeNull();
    expect(result?.orgnr).toBe("974760673");
    expect(result?.name).toContain("BRØNNØYSUND");
    expect(result?.businessAddress?.country).toBeTruthy();
    expect(result?.registryUrl).toContain("974760673");
  });

  test("returns null for a checksum-valid but non-existent orgnr", async () => {
    // 100000008: nine digits, MOD-11 valid, not registered.
    const result = await lookupByOrgnr("100000008");
    expect(result).toBeNull();
  });
});

describe("lookupByOrgnr validation", () => {
  test("throws BrregValidationError for short input", () => {
    expect(lookupByOrgnr("12345678")).rejects.toBeInstanceOf(
      BrregValidationError,
    );
  });

  test("throws BrregValidationError on bad checksum", () => {
    expect(lookupByOrgnr("974760674")).rejects.toBeInstanceOf(
      BrregValidationError,
    );
  });
});

describe.skipIf(SKIP_LIVE)("searchByName live", () => {
  test("finds Equinor", async () => {
    const results = await searchByName("Equinor", { limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.name.toUpperCase().includes("EQUINOR"))).toBe(
      true,
    );
  });
});

describe("searchByName validation", () => {
  test("rejects empty input", () => {
    expect(searchByName("")).rejects.toBeInstanceOf(BrregValidationError);
    expect(searchByName("   ")).rejects.toBeInstanceOf(BrregValidationError);
  });

  test("rejects overlong input", () => {
    expect(searchByName("a".repeat(181))).rejects.toBeInstanceOf(
      BrregValidationError,
    );
  });
});

describe("searchByName upstream 400 handling", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("translates Brreg's broad-query HTTP 400 into BrregTooBroadError", () => {
    const stub = async () =>
      new Response(
        JSON.stringify({
          feilmelding: "Spørringen returnerer for mange treff",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    globalThis.fetch = Object.assign(stub, {
      preconnect: originalFetch.preconnect,
    });

    expect(searchByName("a")).rejects.toBeInstanceOf(BrregTooBroadError);
  });
});
