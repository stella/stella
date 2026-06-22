import { describe, expect, test } from "bun:test";

import { generate, LOCALES, parseGlossary, renderTable } from "./glossary-gen";

const fill = (value: string): Record<string, string> =>
  Object.fromEntries(LOCALES.map((locale) => [locale, value]));

const glossary = parseGlossary(
  JSON.stringify({
    verbs: [{ id: "save", en: "Save", translations: fill("S") }],
    legalConcepts: [{ id: "matter", en: "Matter", translations: fill("M") }],
    ptBR: [{ en: "Matter", "pt-BR": "Caso", note: "note" }],
  }),
);

const blankDoc = [
  "<!-- glossary-gen:verbs-slavic-baltic start -->",
  "<!-- glossary-gen:verbs-slavic-baltic end -->",
  "<!-- glossary-gen:verbs-romance start -->",
  "<!-- glossary-gen:verbs-romance end -->",
  "<!-- glossary-gen:legal-slavic-baltic start -->",
  "<!-- glossary-gen:legal-slavic-baltic end -->",
  "<!-- glossary-gen:legal-romance start -->",
  "<!-- glossary-gen:legal-romance end -->",
  "<!-- glossary-gen:verbs-arabic start -->",
  "<!-- glossary-gen:verbs-arabic end -->",
  "<!-- glossary-gen:legal-arabic start -->",
  "<!-- glossary-gen:legal-arabic end -->",
  "<!-- glossary-gen:ptbr-special start -->",
  "<!-- glossary-gen:ptbr-special end -->",
  "",
].join("\n");

describe("renderTable", () => {
  test("pads each column to its widest cell (oxfmt-canonical)", () => {
    expect(
      renderTable(
        ["A", "Long header"],
        [
          ["x", "y"],
          ["longcell", "z"],
        ],
      ),
    ).toBe(
      [
        "| A        | Long header |",
        "| -------- | ----------- |",
        "| x        | y           |",
        "| longcell | z           |",
      ].join("\n"),
    );
  });

  test("counts a diacritic as one column, not its UTF-8 byte length", () => {
    // "Uložiť" is six code points; the column pads to six, not nine bytes.
    expect(renderTable(["X"], [["Uložiť"], ["a"]])).toBe(
      ["| X      |", "| ------ |", "| Uložiť |", "| a      |"].join("\n"),
    );
  });
});

describe("generate", () => {
  test("fills every marked region with its table", () => {
    const result = generate(blankDoc, glossary);
    expect(result).toContain("| **Save** |");
    expect(result).toContain("Brazilian Portuguese");
    expect(result).toContain("| **Matter** |");
    expect(result).toContain("| English | pt-BR | Notes |");
    expect(result).toContain("Arabic");
  });

  test("is idempotent (a formatter and CI fixpoint)", () => {
    const once = generate(blankDoc, glossary);
    expect(generate(once, glossary)).toBe(once);
  });

  test("throws when a region marker is missing", () => {
    expect(() => generate("no markers here", glossary)).toThrow(
      /missing the `verbs-slavic-baltic` markers/u,
    );
  });
});

describe("parseGlossary", () => {
  test("rejects a term missing a locale", () => {
    expect(() =>
      parseGlossary(
        JSON.stringify({
          verbs: [{ id: "save", en: "Save", translations: { cs: "Uložit" } }],
          legalConcepts: [],
          ptBR: [],
        }),
      ),
    ).toThrow(/missing translation for/u);
  });

  test("rejects an unknown locale", () => {
    expect(() =>
      parseGlossary(
        JSON.stringify({
          verbs: [
            { id: "save", en: "Save", translations: { ...fill("S"), xx: "S" } },
          ],
          legalConcepts: [],
          ptBR: [],
        }),
      ),
    ).toThrow(/unknown locale "xx"/u);
  });

  test("rejects an unknown locale in forbidden", () => {
    expect(() =>
      parseGlossary(
        JSON.stringify({
          verbs: [
            {
              id: "save",
              en: "Save",
              forbidden: { xx: ["Foo"] },
              translations: fill("S"),
            },
          ],
          legalConcepts: [],
          ptBR: [],
        }),
      ),
    ).toThrow(/unknown locale "xx" in/u);
  });
});
