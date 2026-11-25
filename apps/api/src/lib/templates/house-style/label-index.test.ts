import { describe, expect, test } from "bun:test";

import type { DocxBlockManifest } from "@/api/lib/templates/house-style/folio-contract";
import { buildLabelIndex } from "@/api/lib/templates/house-style/label-index";
import {
  blockIdOf,
  czechContract,
  englishAgreement,
  germanContract,
  heading,
  manifestOf,
  numbered,
  partsContract,
  provisionKey,
} from "@/api/lib/templates/house-style/manifest.test-helpers";

/** Every indexed block as `<level> <key>`, in document order. */
const keysOf = (manifest: DocxBlockManifest): string[] => {
  const index = buildLabelIndex(manifest);
  return index.entries.map((entry) => {
    const key = provisionKey(index, entry.blockId);
    // Annex and recital keys already say what they are.
    return entry.level === "annex" || entry.level === "recital"
      ? key
      : `${entry.level} ${key}`;
  });
};

describe("buildLabelIndex", () => {
  test("typed article headings over automatic paragraphs, letters and points", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I.\nPředmět",
      numbered("1.", "První odstavec.", 1),
      numbered("2.", "Druhý odstavec:", 1),
      numbered("a)", "první případ;", 2),
      numbered("b)", "druhý případ:", 2),
      numbered("(i)", "první podbod;", 3),
      numbered("(ii)", "druhý podbod;", 3),
      numbered("c)", "třetí případ.", 2),
      "Pokračování druhého odstavce.",
      numbered("3.", "Třetí odstavec.", 1),
      "Článek II.\nCena",
      numbered("1.", "První odstavec.", 4),
    ]);
    expect(keysOf(manifest)).toEqual([
      "article I",
      "clause I/1",
      "clause I/2",
      "letter I/2/a",
      "letter I/2/b",
      "roman I/2/b/i",
      "roman I/2/b/ii",
      "letter I/2/c",
      "clause I/3",
      "article II",
      "clause II/1",
    ]);
    const index = buildLabelIndex(manifest);
    expect(
      index.contextByBlockId.get(blockIdOf(manifest, "Pokračování")),
    ).toEqual({
      articleBlockId: blockIdOf(manifest, "Článek I."),
      clauseBlockId: blockIdOf(manifest, "Druhý odstavec"),
      itemBlockId: blockIdOf(manifest, "třetí případ"),
      annexBlockId: null,
    });
    expect(index.usesSectionSign).toBe(false);
  });

  test("a heading split over two paragraphs takes its title from the next one", () => {
    const manifest = manifestOf([
      "Článek I.",
      "Úvodní ustanovení",
      numbered("1.", "Text.", 1),
      "Článek II.\nCena",
      numbered("1.", "Text.", 2),
      "Článek III.",
      numbered("1.", "Článek bez nadpisu.", 3),
    ]);
    const index = buildLabelIndex(manifest);
    expect(
      index.entries
        .filter(({ level }) => level === "article")
        .map(({ title, titleBlockId }) => ({ title, titleBlockId })),
    ).toEqual([
      { title: "Úvodní ustanovení", titleBlockId: "p1" },
      { title: "Cena", titleBlockId: null },
      { title: "", titleBlockId: null },
    ]);
    expect(index.entryByBlockId.has("p1")).toBe(false);
  });

  test("a typed label carries the length a plan strips", () => {
    const manifest = manifestOf([
      "Článek I. \nPředmět",
      "1.\tPrvní odstavec.",
      "2.  Druhý odstavec.",
      "a)\tprvní případ;",
      "(b) druhý případ.",
      "\t3.\tTřetí odstavec.",
    ]);
    const index = buildLabelIndex(manifest);
    expect(
      manifest.blocks.map(({ id, text }) =>
        text.slice(0, index.entryByBlockId.get(id)?.manualLength ?? 0),
      ),
    ).toEqual(["Článek I. ", "1.\t", "2.  ", "a)\t", "(b) ", "\t3.\t"]);
    expect(keysOf(manifest)).toEqual([
      "article I",
      "clause I/1",
      "clause I/2",
      "letter I/2/a",
      "letter I/2/b",
      "clause I/3",
    ]);
  });

  test("a sentence that opens with a number or a provision's name is not a label", () => {
    const manifest = manifestOf([
      "Článek I.\nLhůty",
      numbered("1.", "Text.", 1),
      "10 dnů před zahájením prací oznámí dodavatel termín.",
      "1. ledna 2030 nabývá smlouva účinnosti.",
      "Článek 5 této smlouvy se použije obdobně.",
      "Příloha č. 1 této smlouvy obsahuje ceník.",
      "V Praze dne 1. 1. 2030",
      "a. s. je akciová společnost.",
    ]);
    expect(keysOf(manifest)).toEqual(["article I", "clause I/1"]);
  });

  test("the dotted scheme: bare numbers head the articles", () => {
    expect(keysOf(englishAgreement("Text."))).toEqual([
      "recital a",
      "recital b",
      "article 1",
      "clause 1/1",
      "clause 1/2",
      "clause 1/3",
      "article 2",
      "clause 2/1",
      "clause 2/2",
      "clause 2/3",
      "letter 2/3/a",
      "letter 2/3/b",
      "roman 2/3/b/i",
      "roman 2/3/b/ii",
      "article 3",
      "clause 3/1",
      "clause 3/2",
      "clause 3/3",
      "article 4",
      "clause 4/1",
      "clause 4/2",
      "clause 4/3",
      "article 5",
      "clause 5/1",
      "clause 5/2",
      "clause 5/3",
      "article 6",
      "clause 6/1",
      "clause 6/2",
      "clause 6/3",
      "annex 1",
      // The annex's own numbering; never a target for the agreement's text.
      "clause -/1",
      "annex 2",
    ]);
  });

  test("parts in roman numerals head dotted articles", () => {
    expect(keysOf(partsContract("Text."))).toEqual([
      "article I",
      "clause I/1",
      "clause I/2",
      "clause I/2.1",
      "clause I/2.2",
      "article II",
      "clause II/1",
      "clause II/2",
      "clause II/2.1",
    ]);
  });

  test("deeper dotted levels nest under their clause", () => {
    const manifest = manifestOf([
      { ...heading("Services"), label: "1." },
      numbered("1.1", "Clause."),
      numbered("1.1.1", "Sub-clause."),
      numbered("1.1.2", "Sub-clause."),
      numbered("1.2", "Clause."),
    ]);
    const index = buildLabelIndex(manifest);
    expect(keysOf(manifest)).toEqual([
      "article 1",
      "clause 1/1",
      "clause 1/1.1",
      "clause 1/1.2",
      "clause 1/2",
    ]);
    expect(index.entryByBlockId.get("p2")?.parentBlockId).toBe("p1");
    expect(index.entryByBlockId.get("p4")?.parentBlockId).toBe("p0");
  });

  test("dotted sub-clauses that restart in every named article", () => {
    const manifest = manifestOf([
      "Článek I.\nPrvní",
      numbered("1.", "Odstavec.", 1),
      numbered("1.1", "Pododstavec.", 1),
      "Článek II.\nDruhý",
      numbered("1.", "Odstavec.", 2),
      numbered("1.1", "Pododstavec.", 2),
      numbered("1.2", "Pododstavec.", 2),
    ]);
    expect(keysOf(manifest)).toEqual([
      "article I",
      "clause I/1",
      "clause I/1.1",
      "article II",
      "clause II/1",
      "clause II/1.1",
      "clause II/1.2",
    ]);
  });

  test("a section sign heading marks the document as numbering by it", () => {
    const manifest = germanContract("Text.");
    const index = buildLabelIndex(manifest);
    expect(index.usesSectionSign).toBe(true);
    expect(keysOf(manifest).slice(0, 9)).toEqual([
      "article 1",
      "clause 1/1",
      "clause 1/2",
      "clause 1/3",
      "article 2",
      "clause 2/1",
      "clause 2/2",
      "clause 2/3",
      "article 3",
    ]);
    expect(keysOf(manifest).at(-1)).toBe("annex 1");
  });

  test("single characters that are letter and numeral follow their list", () => {
    const letters = "abcdefghij".split("");
    const manifest = manifestOf([
      "Článek I.\nVýčet",
      numbered("1.", "Případy:", 1),
      ...letters.map((letter) => numbered(`${letter})`, "případ;", 2)),
      numbered("2.", "Podbody:", 1),
      numbered("i)", "první;", 3),
      numbered("ii)", "druhý;", 3),
      numbered("iii)", "třetí;", 3),
      numbered("iv)", "čtvrtý;", 3),
      numbered("v)", "pátý.", 3),
    ]);
    const index = buildLabelIndex(manifest);
    expect(
      index.entries
        .filter(
          ({ core, level }) =>
            (level === "letter" || level === "roman") &&
            (core === "i" || core === "v"),
        )
        .map((entry) => `${entry.level} ${provisionKey(index, entry.blockId)}`),
    ).toEqual(["letter I/1/i", "roman I/2/i", "roman I/2/v"]);
  });

  test("a typed list after a new clause does not continue the list before it", () => {
    const manifest = manifestOf([
      "Článek I.\nVýčet",
      numbered("1.", "Případy:", 1),
      "g) sedmý;",
      "h) osmý.",
      numbered("2.", "Podbody:", 1),
      "i) první;",
      "ii) druhý.",
    ]);
    expect(keysOf(manifest).slice(-3)).toEqual([
      "clause I/2",
      "roman I/2/i",
      "roman I/2/ii",
    ]);
  });

  test("roman headings keep counting across the numbered clauses between them", () => {
    const manifest = manifestOf([
      "IX. Sankce",
      numbered("1.", "Text.", 1),
      "X. Závěr",
      numbered("1.", "Text.", 2),
    ]);
    expect(keysOf(manifest)).toEqual([
      "article IX",
      "clause IX/1",
      "article X",
      "clause X/1",
    ]);
  });

  test("annexes: the list of annexes and the headings behind the signatures", () => {
    const manifest = czechContract("Text.");
    const index = buildLabelIndex(manifest);
    expect(
      index.entries
        .filter(({ level }) => level === "annex")
        .map(({ core, listed, title, titleBlockId }) => ({
          core,
          listed,
          title,
          split: titleBlockId !== null,
        })),
    ).toEqual([
      { core: "1", listed: true, title: "Specifikace", split: false },
      { core: "2", listed: true, title: "Ceník", split: false },
      { core: "1", listed: false, title: "Specifikace", split: true },
      { core: "2", listed: false, title: "Ceník", split: false },
    ]);
    // An annex's own numbering is not the contract's.
    const inAnnex = index.entries.filter(
      ({ annexBlockId }) => annexBlockId !== null,
    );
    expect(
      inAnnex.map(({ level, articleBlockId }) => [level, articleBlockId]),
    ).toEqual([
      ["clause", null],
      ["clause", null],
    ]);
  });

  test("an annex numbers on its own and does not change how the body is read", () => {
    const decimalBody = manifestOf([
      { ...heading("Services"), label: "1." },
      numbered("1.1", "Clause."),
      "Signed by the parties.",
      "Annex 1",
      "Article I.\nScope",
      numbered("1.", "Annex paragraph.", 2),
    ]);
    expect(keysOf(decimalBody)).toEqual([
      "article 1",
      "clause 1/1",
      "annex 1",
      "article I",
      "clause I/1",
    ]);
    const namedBody = manifestOf([
      "Článek I.\nPředmět",
      numbered("1.", "Odstavec.", 1),
      numbered("2.", "Odstavec.", 1),
      "V Praze dne ……",
      "Příloha č. 1",
      numbered("1.", "Bod přílohy.", 2),
      numbered("1.1", "Podbod přílohy.", 2),
    ]);
    expect(keysOf(namedBody)).toEqual([
      "article I",
      "clause I/1",
      "clause I/2",
      "annex 1",
      "article 1",
      "clause 1/1",
    ]);
  });

  test("an annex named in front of the first article is not the annex", () => {
    const manifest = manifestOf([
      "GUIDANCE",
      "Appendix 1",
      "Complete the timetable before signature.",
      { ...heading("Services"), label: "1." },
      numbered("1.1", "Clause."),
      "Signed by the parties.",
      "Appendix 1: Timetable",
      "The milestones are set out below.",
    ]);
    const index = buildLabelIndex(manifest);
    expect(
      index.entries
        .filter(({ level }) => level === "annex")
        .map(({ blockId, listed }) => ({ blockId, listed })),
    ).toEqual([
      { blockId: "p1", listed: true },
      { blockId: "p6", listed: false },
    ]);
    // The agreement's own clauses stay in the main body.
    expect(index.entryByBlockId.get("p4")).toMatchObject({
      level: "clause",
      annexBlockId: null,
    });
  });

  test("a document that is itself an annex numbers its own main body", () => {
    const manifest = manifestOf([
      "Příloha č. 5",
      "Podmínky zpracování osobních údajů",
      "Článek I.\nPředmět",
      numbered("1.", "Odstavec.", 1),
    ]);
    const index = buildLabelIndex(manifest);
    expect(keysOf(manifest)).toEqual([
      "listed annex 5",
      "article I",
      "clause I/1",
    ]);
    expect(index.entryByBlockId.get("p3")?.annexBlockId).toBeNull();
  });

  test("a typed line that names an automatically numbered article refers to it", () => {
    const manifest = manifestOf([
      { ...heading("Definitions"), label: "1." },
      numbered("1.1", "Clause."),
      { ...heading("Data Protection"), label: "2." },
      numbered("2.1", "The following survive termination:"),
      "Clause 1 Definitions",
      "Clause 2 Data Protection",
    ]);
    expect(keysOf(manifest)).toEqual([
      "article 1",
      "clause 1/1",
      "article 2",
      "clause 2/1",
    ]);
  });

  test("lines of the list of annexes may end like items of an enumeration", () => {
    const manifest = manifestOf([
      "Článek I.\nPřílohy",
      numbered("1.", "Nedílnou součástí této smlouvy jsou:", 1),
      "Příloha č. 1\tTechnická specifikace a popis výchozího stavu;",
      "Příloha č. 2:\tCeník, který je pro dodavatele závazný po celou dobu trvání smlouvy.",
      "Příloha č. 3 - Smlouvy uzavřené s poddodavateli",
      numbered("2.", "Příloha č. 1 této smlouvy má přednost před nabídkou.", 1),
    ]);
    expect(keysOf(manifest)).toEqual([
      "article I",
      "clause I/1",
      "listed annex 1",
      "listed annex 2",
      "listed annex 3",
      "clause I/2",
    ]);
  });

  test("lines of a table of contents are left out", () => {
    const manifest = manifestOf([
      { text: "Článek I. Předmět", styleName: "TOC 1" },
      "Článek II. Cena\t4",
      "Článek I.\nPředmět",
      numbered("1.", "Text.", 1),
    ]);
    const index = buildLabelIndex(manifest);
    expect([...index.contentsBlockIds]).toEqual(["p0", "p1"]);
    expect(keysOf(manifest)).toEqual(["article I", "clause I/1"]);
  });

  test("a roman numeral alone on its line heads an article", () => {
    const manifest = manifestOf([
      "I.",
      "Úvodní ustanovení",
      numbered("1)", "Text.", 1),
      "II. ",
      "Definice pojmů",
      numbered("1)", "Text.", 2),
      numbered("2)", "Text.", 2),
    ]);
    const index = buildLabelIndex(manifest);
    expect(keysOf(manifest)).toEqual([
      "article I",
      "clause I/1",
      "article II",
      "clause II/1",
      "clause II/2",
    ]);
    expect(index.entryByBlockId.get("p3")).toMatchObject({
      title: "Definice pojmů",
      titleBlockId: "p4",
    });
  });

  test("roman headings without a keyword", () => {
    const manifest = manifestOf([
      "I. Úvodní ustanovení",
      numbered("1.", "Text.", 1),
      "II. Cena",
      numbered("1.", "Text.", 2),
      numbered("2.", "Text.", 2),
    ]);
    expect(keysOf(manifest)).toEqual([
      "article I",
      "clause I/1",
      "article II",
      "clause II/1",
      "clause II/2",
    ]);
  });
});
