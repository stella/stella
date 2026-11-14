import { describe, expect, test } from "bun:test";

import { isCountryCode } from "@stll/country-codes";
import { UI_LOCALES } from "@stll/locales";
import {
  MARKETING_LOCALE_ACCOUNTS,
  MARKETING_LOCALES,
  PRIMARY_MARKETING_LOCALE,
} from "@stll/playwright-tools/marketing-locales";

import { resolveSeedLocale, seedsSharedCorpus } from "./locales";

const accounts = MARKETING_LOCALES.map(
  (locale) => [locale, MARKETING_LOCALE_ACCOUNTS[locale]] as const,
);

describe("marketing markets", () => {
  test.each(accounts)(
    "%s renders a UI language for a known country",
    (_locale, account) => {
      expect(UI_LOCALES).toContain(account.language);
      expect(isCountryCode(account.country)).toBe(true);
    },
  );

  test("each firm, owner and PNG suffix belongs to one market", () => {
    for (const key of [
      "organizationId",
      "organizationSlug",
      "userId",
      "email",
      "captureSuffix",
    ] as const) {
      const values = accounts.map(([, account]) => account[key]);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  test("only the primary market keeps the unsuffixed PNG names", () => {
    for (const [locale, account] of accounts) {
      expect(account.captureSuffix === "").toBe(
        locale === PRIMARY_MARKETING_LOCALE,
      );
    }
  });
});

describe("resolveSeedLocale", () => {
  const csFirm = MARKETING_LOCALE_ACCOUNTS.cs.organizationId;

  test("seeds a marketing firm in its own locale", () => {
    expect(
      resolveSeedLocale({ organizationId: csFirm, requested: undefined }),
    ).toBe("cs");
    expect(resolveSeedLocale({ organizationId: csFirm, requested: "cs" })).toBe(
      "cs",
    );
  });

  test("seeds any other organization in the primary locale by default", () => {
    expect(
      resolveSeedLocale({ organizationId: "org-own", requested: undefined }),
    ).toBe(PRIMARY_MARKETING_LOCALE);
    expect(
      resolveSeedLocale({ organizationId: undefined, requested: undefined }),
    ).toBe(PRIMARY_MARKETING_LOCALE);
  });

  test("seeds any other organization in a requested locale", () => {
    expect(
      resolveSeedLocale({ organizationId: "org-own", requested: "sk" }),
    ).toBe("sk");
  });

  test("refuses a locale without a content pack", () => {
    expect(() =>
      resolveSeedLocale({ organizationId: "org-own", requested: "de" }),
    ).toThrow("STELLA_SEED_LOCALE=de has no content pack");
  });

  test("refuses another locale for a marketing firm", () => {
    expect(() =>
      resolveSeedLocale({ organizationId: csFirm, requested: "sk" }),
    ).toThrow("cannot be seeded in sk");
  });
});

describe("seedsSharedCorpus", () => {
  test("only the non-primary marketing firms reuse the corpus", () => {
    for (const [locale, account] of accounts) {
      expect(seedsSharedCorpus(account.organizationId)).toBe(
        locale === PRIMARY_MARKETING_LOCALE,
      );
    }
    expect(seedsSharedCorpus("org-own")).toBe(true);
  });
});
