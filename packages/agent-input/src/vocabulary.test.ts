import { describe, expect, test } from "bun:test";

import type { NormalizedOptional } from "./normalized";
import type { VocabularyEntry } from "./vocabulary";
import { normalizeVocabularyValue } from "./vocabulary";

const COURTS = [
  { value: "Ústavní soud" },
  { value: "Nejvyšší soud", aliases: ["NS"] },
  { value: "Nejvyšší správní soud", aliases: ["NSS"] },
  { value: "Krajský soud v Brně" },
  { value: "Krajský soud v Praze" },
  { value: "Městský soud v Praze" },
] as const satisfies readonly VocabularyEntry[];

const outcome = (result: NormalizedOptional<string>): string => {
  if (result.ok === "absent") {
    return "absent";
  }
  return result.ok ? result.value : `ask: ${result.hint}`;
};

const read = (input: unknown): string =>
  outcome(normalizeVocabularyValue(input, COURTS, { label: "The courts" }));

describe("values drawn from data", () => {
  test("an exact value is taken as it is", () => {
    expect(normalizeVocabularyValue("Ústavní soud", COURTS)).toEqual({
      ok: true,
      value: "Ústavní soud",
    });
  });

  test.each([
    ["ustavni soud", "Ústavní soud"],
    ["ÚSTAVNÍ  SOUD", "Ústavní soud"],
    ['"Nejvyšší soud."', "Nejvyšší soud"],
    ["krajsky-soud_v_brne", "Krajský soud v Brně"],
    ["nss", "Nejvyšší správní soud"],
    // The country appended in running text.
    ["Ústavní soud České republiky", "Ústavní soud"],
    ["NS ČR", "Nejvyšší soud"],
    // The entry naming the most of the input's words wins over one it merely
    // contains: "Nejvyšší soud" is inside this too.
    ["Nejvyšší správní soud ČR", "Nejvyšší správní soud"],
    // Cut short, but only one entry has these words.
    ["Městský soud", "Městský soud v Praze"],
    ["soud v Brně", "Krajský soud v Brně"],
  ])("reads %s as %s", (input, value) => {
    const result = normalizeVocabularyValue(input, COURTS);
    expect(outcome(result)).toBe(value);
    expect(result.ok === true && result.note).toBe(
      `Read ${JSON.stringify(input)} as ${JSON.stringify(value)}.`,
    );
  });

  test("a spelling cut short to several entries asks and names them", () => {
    expect(read("Krajský soud")).toBe(
      'ask: Did you mean one of "Krajský soud v Brně", "Krajský soud v Praze"?',
    );
  });

  test("an input containing two entries equally asks and names both", () => {
    expect(read("Krajský soud v Praze Městský soud v Praze")).toBe(
      'ask: Did you mean one of "Krajský soud v Praze", "Městský soud v Praze"?',
    );
  });

  // Two stored spellings of one court, both given the same abbreviation or
  // folding to the same words: the first listed is not the one meant.
  test.each([
    [
      "NS",
      [
        { value: "Nejvyšší soud", aliases: ["NS"] },
        { value: "Nejvyšší soud ČR", aliases: ["NS"] },
      ],
    ],
    ["nejvyssi soud", [{ value: "Nejvyšší soud" }, { value: "NEJVYŠŠÍ SOUD" }]],
  ])("%s matching two stored values asks and names both", (input, entries) => {
    const result = normalizeVocabularyValue(input, entries);
    expect(outcome(result)).toBe(
      `ask: Did you mean one of ${entries.map(({ value }) => `"${value}"`).join(", ")}?`,
    );
  });

  test("one value listed twice under the same alias still reads", () => {
    expect(
      outcome(
        normalizeVocabularyValue("NS", [
          { value: "Nejvyšší soud", aliases: ["NS"] },
          { value: "Nejvyšší soud", aliases: ["NS", "Supreme Court"] },
        ]),
      ),
    ).toBe("Nejvyšší soud");
  });

  test("a spelling matching nothing lists the values, bounded", () => {
    expect(read("Okresní soud")).toBe(
      'ask: The courts include "Ústavní soud", "Nejvyšší soud", "Nejvyšší správní soud", "Krajský soud v Brně", "Krajský soud v Praze", "Městský soud v Praze".',
    );
    expect(
      outcome(
        normalizeVocabularyValue("Okresní soud", COURTS, { maxListed: 2 }),
      ),
    ).toBe(
      'ask: The values include "Ústavní soud", "Nejvyšší soud", and 4 more.',
    );
  });

  test("a placeholder is no value", () => {
    expect(read("(any)")).toBe("absent");
    expect(read("  ")).toBe("absent");
  });

  test("an empty vocabulary asks and says nothing is known", () => {
    expect(outcome(normalizeVocabularyValue("Ústavní soud", []))).toBe(
      "ask: No values are known for this filter; omit the property.",
    );
  });

  test("a value that is not a string asks", () => {
    expect(
      normalizeVocabularyValue(3, COURTS, { expected: "a court" }),
    ).toEqual(expect.objectContaining({ ok: false, expected: "a court" }));
  });
});
