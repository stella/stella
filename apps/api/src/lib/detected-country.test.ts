import { describe, expect, test } from "bun:test";

import {
  detectedCountryFromRequestContext,
  VIEWER_COUNTRY_HEADER,
} from "@/api/lib/detected-country";

const contextWithHeader = (value: string) => ({
  request: new Request("https://api.example.test/sign-up", {
    headers: { [VIEWER_COUNTRY_HEADER]: value },
  }),
});

describe("detectedCountryFromRequestContext", () => {
  test("accepts a known ISO code and normalizes case", () => {
    expect(detectedCountryFromRequestContext(contextWithHeader("cz"))).toBe(
      "CZ",
    );
    expect(detectedCountryFromRequestContext(contextWithHeader("US"))).toBe(
      "US",
    );
  });

  test.each(["ZZ", "A1", "EU", "", "Czechia"])(
    "rejects the non-ISO edge value %j",
    (value) => {
      expect(
        detectedCountryFromRequestContext(contextWithHeader(value)),
      ).toBeUndefined();
    },
  );

  test("returns undefined without a request context or header", () => {
    expect(detectedCountryFromRequestContext(undefined)).toBeUndefined();
    expect(
      detectedCountryFromRequestContext({
        request: new Request("https://api.example.test/sign-up"),
      }),
    ).toBeUndefined();
  });

  test("falls back to bare headers when no request is present", () => {
    expect(
      detectedCountryFromRequestContext({
        headers: new Headers({ [VIEWER_COUNTRY_HEADER]: "SK" }),
      }),
    ).toBe("SK");
  });
});
