import { expect, test } from "bun:test";

import { UI_LOCALES } from "@stll/locales";

import { glossary } from "@/i18n/glossary";

const messagesFor = async (lang: keyof typeof glossary): Promise<unknown> =>
  Bun.file(new URL(`langs/${lang}.json`, import.meta.url)).json();

const messageAt = (messages: unknown, key: string): unknown => {
  let value = messages;
  for (const segment of key.split(".")) {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    value = new Map(Object.entries(value)).get(segment);
  }
  return value;
};

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

test("every language follows its product glossary", async () => {
  for (const lang of UI_LOCALES) {
    const messages = await messagesFor(lang);
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

test("one destination and contact action use one concept in every language", async () => {
  for (const lang of UI_LOCALES) {
    const messages = await messagesFor(lang);
    expect(messageAt(messages, "common.caseLaw")).toBe(
      messageAt(messages, "common.legalDatabase"),
    );
    expect(messageAt(messages, "contacts.deleteContact")).not.toMatch(
      /client|klient/iu,
    );
  }
});
