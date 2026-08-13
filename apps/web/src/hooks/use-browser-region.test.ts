import { describe, expect, test } from "bun:test";

import { regionFromLocale } from "@/hooks/use-browser-region";

describe("browser locale region", () => {
  test("preserves regions independently of supported UI languages", () => {
    expect(regionFromLocale("ja-JP")).toBe("JP");
    expect(regionFromLocale("pt_PT")).toBe("PT");
  });

  test("returns no region for regionless or malformed locales", () => {
    expect(regionFromLocale("en")).toBe("");
    expect(regionFromLocale("not_a_locale!")).toBe("");
    expect(regionFromLocale(undefined)).toBe("");
  });
});
