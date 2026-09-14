import { describe, expect, test } from "bun:test";

import {
  BUSINESS_REGISTRY_FORMAT_CAPABILITIES,
  isBuiltInRegistryFormat,
  isClauseDrivenRegistry,
  parseRegistryFormatMarkdown,
  PREVIOUS_DEFAULT_FORMATS,
  REGISTRY_DEFAULT_FORMAT_CLAUSES,
  REGISTRY_FORMAT_SLUGS,
  stripRegistryFormatMarkdown,
} from "./default-formats";
import { formatFromClauses } from "./format-clauses";

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

describe("clause-driven built-in defaults", () => {
  test.each([...REGISTRY_FORMAT_SLUGS])(
    "%s derives its default from its clause list, when it has one",
    (slug) => {
      if (isClauseDrivenRegistry(slug)) {
        expect(BUSINESS_REGISTRY_FORMAT_CAPABILITIES[slug].defaultFormat).toBe(
          formatFromClauses(REGISTRY_DEFAULT_FORMAT_CLAUSES[slug]),
        );
      }
    },
  );

  test.each([...REGISTRY_FORMAT_SLUGS])(
    "%s keeps every string it ever shipped recognisable as built-in",
    (slug) => {
      const { defaultFormat } = BUSINESS_REGISTRY_FORMAT_CAPABILITIES[slug];
      expect(isBuiltInRegistryFormat(slug, defaultFormat)).toBe(true);

      const previous: readonly string[] =
        Object.entries(PREVIOUS_DEFAULT_FORMATS).find(
          ([registry]) => registry === slug,
        )?.[1] ?? [];
      // A retired string is never also the current one: that would mean a
      // default changed without its old text being recorded.
      expect(previous).not.toContain(defaultFormat);
      for (const format of previous) {
        expect(isBuiltInRegistryFormat(slug, format)).toBe(true);
      }
    },
  );

  test("a registry does not adopt another registry's retired default", () => {
    expect(
      isBuiltInRegistryFormat("orsr", PREVIOUS_DEFAULT_FORMATS.ares[0]),
    ).toBe(false);
    expect(
      isBuiltInRegistryFormat("ares", PREVIOUS_DEFAULT_FORMATS.orsr[0]),
    ).toBe(false);
  });
});
