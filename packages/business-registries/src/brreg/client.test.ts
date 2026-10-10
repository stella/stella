import { afterEach, describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { lookupByOrgnr, searchByName } from "./client.js";
import { BrregTooBroadError, BrregValidationError } from "./errors.js";

describe("lookupByOrgnr validation", () => {
  test("throws BrregValidationError for short input", async () => {
    expect(
      await rejectionOf(lookupByOrgnr("12345678", { observer: "unobserved" })),
    ).toBeInstanceOf(BrregValidationError);
  });

  test("throws BrregValidationError on bad checksum", async () => {
    expect(
      await rejectionOf(lookupByOrgnr("974760674", { observer: "unobserved" })),
    ).toBeInstanceOf(BrregValidationError);
  });
});

describe("searchByName validation", () => {
  test("rejects empty input", async () => {
    expect(
      await rejectionOf(searchByName("", { observer: "unobserved" })),
    ).toBeInstanceOf(BrregValidationError);
    expect(
      await rejectionOf(searchByName("   ", { observer: "unobserved" })),
    ).toBeInstanceOf(BrregValidationError);
  });

  test("rejects overlong input", async () => {
    expect(
      await rejectionOf(
        searchByName("a".repeat(181), { observer: "unobserved" }),
      ),
    ).toBeInstanceOf(BrregValidationError);
  });
});

describe("searchByName upstream 400 handling", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("translates Brreg's broad-query HTTP 400 into BrregTooBroadError", async () => {
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
      await rejectionOf(searchByName("a", { observer: "unobserved" })),
    ).toBeInstanceOf(BrregTooBroadError);
  });
});
