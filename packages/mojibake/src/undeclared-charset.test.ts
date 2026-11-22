/**
 * Bytes with no byte-order mark and no declared charset, read through
 * `decodeDeclared` as every user file is:
 *
 * - valid UTF-8 always reads back unchanged, as UTF-8;
 * - text in a language the legacy candidates write, saved in a candidate
 *   that can hold it, reads back exactly, whatever its words' order and
 *   frequency.
 */
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertySeed } from "@stll/property-testing";

import { type Charset, encodeText } from "./charsets.js";
import { decodeDeclared } from "./declared-charset.js";
import { UDHR_ARTICLE_1, type UdhrLanguage } from "./udhr-article-1.fixture.js";

const LEGACY_CHARSETS = [
  "windows-1250",
  "windows-1252",
  "iso-8859-2",
] as const satisfies readonly Charset[];

type LegacyCharset = (typeof LEGACY_CHARSETS)[number];

/** UDHR languages whose letters the legacy candidates write. */
const LEGACY_LANGUAGES = [
  "cs",
  "sk",
  "pl",
  "hu",
  "de",
  "sl",
  "fr",
  "es",
  "pt",
] as const satisfies readonly UdhrLanguage[];

const isUtf8 = (bytes: Uint8Array): boolean =>
  Result.try(() =>
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ).isOk();

/**
 * Samples no reading of their letters can tell apart. The Slovenian sample's
 * one non-ASCII word, "življenja", is "ľivljenja" when its ISO-8859-2 bytes
 * are read as windows-1250: a spelling Slovak letters write too, so the tie
 * goes to the earlier candidate.
 */
const INDISTINGUISHABLE: readonly { language: string; charset: string }[] = [
  { language: "sl", charset: "iso-8859-2" },
];

/** Every language and legacy charset that holds it, as bytes that are not UTF-8. */
const SAVED = LEGACY_LANGUAGES.flatMap((language) =>
  LEGACY_CHARSETS.flatMap((charset) => {
    const bytes = encodeText(UDHR_ARTICLE_1[language], charset);
    const indistinguishable = INDISTINGUISHABLE.some(
      (sample) => sample.language === language && sample.charset === charset,
    );
    return bytes === null || isUtf8(bytes) || indistinguishable
      ? []
      : [{ language, charset }];
  }),
);

const saved = (text: string, charset: LegacyCharset): Uint8Array => {
  const bytes = encodeText(text, charset);
  if (bytes === null) {
    throw new Error(`the fixture is writable in ${charset}`);
  }
  return bytes;
};

const PLAIN_TEXT = { contentType: "text/plain" };

describe("a text file that declares no charset", () => {
  // A lease clause and a payment ledger as a Czech office saves them from
  // Notepad or Excel: windows-1250, no byte-order mark.
  const LEASE = [
    "Nájemce se zavazuje platit nájemné vždy do patnáctého dne příslušného měsíce",
    "na účet pronajímatele. Při prodlení s úhradou vzniká pronajímateli nárok",
    "na úrok z prodlení ve výši stanovené nařízením vlády.",
    "Smlouvu lze vypovědět v tříměsíční výpovědní lhůtě, která počíná běžet",
    "prvním dnem měsíce následujícího po doručení výpovědi druhé smluvní straně.",
  ].join("\r\n");
  const LEDGER = [
    "Dlužník;Částka;Splatnost;Poznámka",
    "Dvořák Tomáš;12 500,00 Kč;15. 3. 2026;splátka nájmu – březen",
    "Šťastná Lucie;8 750,00 Kč;31. 3. 2026;„zálohy na služby“",
    "Kořínek Jiří;3 200,00 Kč;15. 4. 2026;vyúčtování energií",
  ].join("\r\n");

  test.each([
    ["a lease clause", LEASE],
    ["a payment ledger", LEDGER],
  ])("saved in windows-1250 reads back exactly: %s", (_, text) => {
    const bytes = saved(text, "windows-1250");
    expect(isUtf8(bytes)).toBe(false);
    expect(decodeDeclared(bytes, PLAIN_TEXT)).toEqual({
      text,
      charset: "windows-1250",
      source: "undeclared",
    });
  });

  test("saved in ISO-8859-2 reads back exactly", () => {
    expect(decodeDeclared(saved(LEASE, "iso-8859-2"), PLAIN_TEXT)).toEqual({
      text: LEASE,
      charset: "iso-8859-2",
      source: "undeclared",
    });
  });

  test("Slovak, whose ľ and ĺ sit apart in windows-1250 and ISO-8859-2, reads back in each", () => {
    const text = `${UDHR_ARTICLE_1.sk} Ľudia, ktorí sa sťažujú, nesmú byť pre to postihnutí ani ľahkovážne odmietnutí.`;
    for (const charset of ["windows-1250", "iso-8859-2"] as const) {
      expect(decodeDeclared(saved(text, charset), PLAIN_TEXT)).toEqual({
        text,
        charset,
        source: "undeclared",
      });
    }
  });

  test("saved in windows-1252 reads back exactly", () => {
    const text = `${UDHR_ARTICLE_1.fr}\n${UDHR_ARTICLE_1.pt}`;
    expect(decodeDeclared(saved(text, "windows-1252"), PLAIN_TEXT)).toEqual({
      text,
      charset: "windows-1252",
      source: "undeclared",
    });
  });

  test.each(SAVED)(
    "Article 1 in $language, saved in $charset, reads back exactly",
    ({ language, charset }) => {
      const text = UDHR_ARTICLE_1[language];
      expect(decodeDeclared(saved(text, charset), PLAIN_TEXT).text).toBe(text);
    },
  );

  test("UTF-8 cut inside its last character, as a preview cuts it, stays UTF-8", () => {
    const bytes = new TextEncoder().encode(`${LEASE}\r\nPodpis: Dvořák`);
    // "á" is two bytes and "k" one; the cut keeps only the first of "á".
    const cut = bytes.subarray(0, -2);
    expect(decodeDeclared(cut, PLAIN_TEXT)).toEqual({
      text: `${LEASE}\r\nPodpis: Dvoř${String.fromCodePoint(0xff_fd)}`,
      charset: "utf-8",
      source: "undeclared",
    });
  });

  test("UTF-8 with one stray byte keeps its UTF-8 letters", () => {
    const utf8 = new TextEncoder().encode(LEASE);
    // A lone windows-1250 "š" pasted into the middle of UTF-8 text.
    const bytes = new Uint8Array([
      ...utf8.subarray(0, 40),
      0x9a,
      ...utf8.subarray(40),
    ]);
    const decoded = decodeDeclared(bytes, PLAIN_TEXT);
    expect(decoded.charset).toBe("utf-8");
    expect(decoded.text).toContain("příslušného");
  });

  test("a declared charset still outranks the guess", () => {
    const bytes = saved(LEASE, "windows-1250");
    expect(
      decodeDeclared(bytes, { contentType: "text/plain; charset=iso-8859-2" }),
    ).toMatchObject({ charset: "iso-8859-2", source: "http" });
  });
});

describe("properties", () => {
  test("valid UTF-8 reads back unchanged", () => {
    assertProperty(
      "valid UTF-8 reads back unchanged",
      fc.property(
        fc
          .string({ unit: "binary", maxLength: 400 })
          // A leading U+FEFF is a byte-order mark and a "<" can start a
          // declaration: both are read before the bytes count as undeclared.
          .filter(
            (text) =>
              text.isWellFormed() &&
              !text.startsWith("﻿") &&
              !text.includes("<"),
          ),
        (text) => {
          expect(
            decodeDeclared(new TextEncoder().encode(text), PLAIN_TEXT),
          ).toEqual({ text, charset: "utf-8", source: "undeclared" });
        },
      ),
      { numRuns: 300, seed: propertySeed() },
    );
  });

  test("legacy text reads back whatever its words' order and frequency", () => {
    const separators = fc.constantFrom(" ", "\r\n", ";", "\t", ", ");
    assertProperty(
      "legacy text reads back whatever its words' order and frequency",
      fc.property(
        fc.constantFrom(...SAVED).chain(({ language, charset }) => {
          const words = UDHR_ARTICLE_1[language].split(" ");
          return fc.record({
            charset: fc.constant(charset),
            words: fc
              .array(fc.integer({ min: 1, max: 4 }), {
                minLength: words.length,
                maxLength: words.length,
              })
              .map((counts) =>
                words.flatMap((word, index) =>
                  Array.from({ length: counts[index] ?? 1 }, () => word),
                ),
              )
              .chain((repeated) =>
                fc.shuffledSubarray(repeated, {
                  minLength: repeated.length,
                }),
              ),
            separators: fc.array(separators, {
              minLength: 200,
              maxLength: 200,
            }),
          });
        }),
        ({ charset, words, separators: between }) => {
          const text = words
            .map((word, index) =>
              index === 0
                ? word
                : `${between[index % between.length] ?? " "}${word}`,
            )
            .join("");
          expect(decodeDeclared(saved(text, charset), PLAIN_TEXT).text).toBe(
            text,
          );
        },
      ),
      { numRuns: 200, seed: propertySeed() },
    );
  });
});
