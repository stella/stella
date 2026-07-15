import { beforeEach, expect, test } from "bun:test";

import { useI18nStore } from "@/i18n/i18n-store";

import { formatCurrencyAmount, formatCurrencyCompact } from "./format-currency";

beforeEach(() => {
  useI18nStore.setState({
    lang: "en",
    loadedLang: "en",
    region: "US",
    regionalFormat: "auto",
    calendar: "auto",
    numberingSystem: "auto",
    weekStart: "auto",
    isLoaded: true,
  });
  void useI18nStore.getState().loadMessages("en");
});

test("formats Indian currency using lakh and crore grouping", () => {
  useI18nStore.getState().setRegionalFormat("en-IN");

  expect(formatCurrencyAmount(10_000_000, "INR")).toBe("₹1,00,000.00");
  expect(formatCurrencyCompact(10_000_000, "INR")).toBe("₹1,00,000");
});

test("automatic format keeps non-Indian grouping for a US browser locale", () => {
  expect(formatCurrencyAmount(10_000_000, "INR")).toBe("₹100,000.00");
});
