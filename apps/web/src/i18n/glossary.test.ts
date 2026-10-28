import { expect, test } from "bun:test";

import { glossary } from "@/i18n/glossary";
import ar from "@/i18n/langs/ar.json";
import cs from "@/i18n/langs/cs.json";
import de from "@/i18n/langs/de.json";
import en from "@/i18n/langs/en.json";
import es from "@/i18n/langs/es.json";
import et from "@/i18n/langs/et.json";
import fr from "@/i18n/langs/fr.json";
import hu from "@/i18n/langs/hu.json";
import lt from "@/i18n/langs/lt.json";
import lv from "@/i18n/langs/lv.json";
import pl from "@/i18n/langs/pl.json";
import pt_BR from "@/i18n/langs/pt-BR.json";
import sk from "@/i18n/langs/sk.json";

const languageCatalogues = [
  { lang: "ar", messages: ar },
  { lang: "cs", messages: cs },
  { lang: "de", messages: de },
  { lang: "en", messages: en },
  { lang: "es", messages: es },
  { lang: "et", messages: et },
  { lang: "fr", messages: fr },
  { lang: "hu", messages: hu },
  { lang: "lt", messages: lt },
  { lang: "lv", messages: lv },
  { lang: "pl", messages: pl },
  { lang: "pt-BR", messages: pt_BR },
  { lang: "sk", messages: sk },
] as const;

const stringsIn = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringsIn);
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
};

const glossaryViolations = (lang: keyof typeof glossary, messages: unknown) =>
  stringsIn(messages).flatMap((message) =>
    glossary[lang]
      .filter(({ banned }) => banned.test(message))
      .map(({ preferred, reason }) => ({ message, preferred, reason })),
  );

test("every language follows its product glossary", () => {
  for (const { lang, messages } of languageCatalogues) {
    expect(glossaryViolations(lang, messages)).toEqual([]);
  }
});

test("the glossary census detects a banned variant", () => {
  expect(
    glossaryViolations("en", { fixture: "Stella is an organisation" }),
  ).toEqual([
    {
      message: "Stella is an organisation",
      preferred: "stella",
      reason: "The product wordmark is always lowercase.",
    },
    {
      message: "Stella is an organisation",
      preferred: "organization",
      reason: "English product copy uses US spelling.",
    },
  ]);
});

test("one destination and contact action use one concept in every language", () => {
  for (const { messages } of languageCatalogues) {
    expect(messages.common.caseLaw).toBe(messages.common.legalDatabase);
    expect(messages.contacts.deleteContact).not.toMatch(/client|klient/iu);
  }
});
