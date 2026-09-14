import { describe, expect, test } from "bun:test";

import {
  BUSINESS_REGISTRY_FORMAT_CAPABILITIES,
  isBuiltInRegistryFormat,
  parseRegistryFormatMarkdown,
  PREVIOUS_DEFAULT_FORMATS,
  stripRegistryFormatMarkdown,
} from "./default-formats";

describe("registry format markdown", () => {
  test("parses supported emphasis for rich previews", () => {
    expect(
      parseRegistryFormatMarkdown("**ACME PLC**, an *active* company"),
    ).toEqual([
      { text: "ACME PLC", style: "bold", start: 0 },
      { text: ", an ", style: "plain", start: 12 },
      { text: "active", style: "italic", start: 17 },
      { text: " company", style: "plain", start: 25 },
    ]);
  });

  test("removes emphasis markers from plain-text clipboard output", () => {
    expect(
      stripRegistryFormatMarkdown("**ACME PLC**, an *active* company"),
    ).toBe("ACME PLC, an active company");
  });
});

describe("isBuiltInRegistryFormat", () => {
  test("accepts the registry's current default", () => {
    expect(
      isBuiltInRegistryFormat(
        "ares",
        BUSINESS_REGISTRY_FORMAT_CAPABILITIES.ares.defaultFormat,
      ),
    ).toBe(true);
  });

  test("accepts a previously shipped default", () => {
    expect(
      isBuiltInRegistryFormat("ares", PREVIOUS_DEFAULT_FORMATS.ares[0]),
    ).toBe(true);
    expect(
      isBuiltInRegistryFormat("krs", PREVIOUS_DEFAULT_FORMATS.krs[0]),
    ).toBe(true);
  });

  test("rejects an authored format, and a previous default of another registry", () => {
    expect(isBuiltInRegistryFormat("ares", "custom [company name]")).toBe(
      false,
    );
    expect(
      isBuiltInRegistryFormat("brreg", PREVIOUS_DEFAULT_FORMATS.krs[0]),
    ).toBe(false);
  });
});
