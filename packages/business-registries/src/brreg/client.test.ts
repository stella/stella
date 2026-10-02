import { afterEach, describe, expect, test } from "bun:test";

import { lookupByOrgnr, searchByName } from "./client.js";
import { BrregTooBroadError, BrregValidationError } from "./errors.js";

describe("lookupByOrgnr validation", () => {
  test("throws BrregValidationError for short input", () => {
    expect(
      lookupByOrgnr("12345678", { observer: "unobserved" }),
    ).rejects.toBeInstanceOf(BrregValidationError);
  });

  test("throws BrregValidationError on bad checksum", () => {
    expect(
      lookupByOrgnr("974760674", { observer: "unobserved" }),
    ).rejects.toBeInstanceOf(BrregValidationError);
  });
});

describe("searchByName validation", () => {
  test("rejects empty input", () => {
    expect(searchByName("", { observer: "unobserved" })).rejects.toBeInstanceOf(
      BrregValidationError,
    );
    expect(
      searchByName("   ", { observer: "unobserved" }),
    ).rejects.toBeInstanceOf(BrregValidationError);
  });

  test("rejects overlong input", () => {
    expect(
      searchByName("a".repeat(181), { observer: "unobserved" }),
    ).rejects.toBeInstanceOf(BrregValidationError);
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

    expect(
      searchByName("a", { observer: "unobserved" }),
    ).rejects.toBeInstanceOf(BrregTooBroadError);
  });
});
