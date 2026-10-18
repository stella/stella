import type { Static } from "elysia";
import { t } from "elysia";

import type { INVOICE_LANGUAGES, InvoiceLanguage } from "@stll/api-contract";

/**
 * A literal union, not `t.UnionEnum`: UnionEnum stamps its first member as the
 * schema default, so an omitted language would become Arabic before the
 * client, organization and seller defaults are consulted.
 */
export const tInvoiceLanguage = t.Union([
  t.Literal("ar"),
  t.Literal("cs"),
  t.Literal("de"),
  t.Literal("en"),
  t.Literal("es"),
  t.Literal("et"),
  t.Literal("fr"),
  t.Literal("hu"),
  t.Literal("lt"),
  t.Literal("lv"),
  t.Literal("pl"),
  t.Literal("pt-BR"),
  t.Literal("sk"),
]);

// Binds the literals to the contract list in both directions.
true satisfies InvoiceLanguage extends Static<typeof tInvoiceLanguage>
  ? true
  : never;
true satisfies Static<typeof tInvoiceLanguage> extends InvoiceLanguage
  ? true
  : never;
true satisfies (typeof INVOICE_LANGUAGES)["length"] extends 13 ? true : never;

const LANGUAGE_BY_COUNTRY: Readonly<
  Record<string, InvoiceLanguage | undefined>
> = {
  AE: "ar",
  AR: "es",
  AT: "de",
  BR: "pt-BR",
  CZ: "cs",
  CZE: "cs",
  DE: "de",
  DEU: "de",
  EE: "et",
  ES: "es",
  FR: "fr",
  HU: "hu",
  LT: "lt",
  LV: "lv",
  PL: "pl",
  PT: "pt-BR",
  SA: "ar",
  SK: "sk",
  SVK: "sk",
};

/** Resolve a supported invoice language from an ISO seller country code. */
export const invoiceLanguageForCountry = (
  country: string | null,
): InvoiceLanguage => {
  if (country === null) {
    return "en";
  }
  const normalized = country.trim().toUpperCase();
  return LANGUAGE_BY_COUNTRY[normalized] ?? "en";
};
