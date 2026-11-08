import { describe, expect, test } from "bun:test";

import { isTableOfContentsEntry } from "./contents-entry";

describe("a printed table of contents", () => {
  // Entries of DOZIK-5/2024 (Prezes UOKiK) as its PDF prints them.
  test.each([
    "Prezes Urzędu ustalił następujący stan faktyczny .......................................................................... 9",
    "1. Sprzedawca Amazon EU SARL ............................................................................................ 9",
    "2. Proces zakupowy na Amazon.pl ........................................................................................ 10 2.1. Katalog produktów ........................................ 11",
    "3. Moment zawarcia umowy sprzedaży na Amazon.pl.................................................................. 26",
    "14. Pouczenie …………… 106",
  ])("is navigation: %s", (text) => {
    expect(isTableOfContentsEntry(text)).toBe(true);
  });

  test.each([
    "Przewodniczący:…………………………",
    "(…) 24 września 2022 r. zawarłem z firmą umowę zakupu książki",
    // A leader-like run inside prose, with a paragraph of text after it.
    `Pozwany wskazał kwotę ....... 5 tysięcy złotych. ${"Sąd rozważył argumenty stron i doszedł do przekonania, że powództwo zasługuje na uwzględnienie w całości. ".repeat(3)}`,
    "Kwota 1.000.000 zł",
    "",
  ])("is text: %s", (text) => {
    expect(isTableOfContentsEntry(text)).toBe(false);
  });
});
