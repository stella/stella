/**
 * Properties of the judge match key.
 *
 * The key decides whether a name printed on a decision finds its roster row,
 * so the axes that must never move it are the ones publishers vary: the
 * titles around the name, the diacritics on it, the spacing between the
 * parts, and the order the parts are printed in. What must move it is a
 * different person.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig, propertySeed } from "@stll/property-testing";
import { stripDiacritics } from "@stll/text-normalize";

import {
  judgeNameKey,
  stripAcademicTitles,
} from "@/api/handlers/case-law/judges/judge-name";

const config = (numRuns: number) =>
  propertyConfig({ numRuns, seed: propertySeed() });

/**
 * Invented names built from ordinary Czech given names and surnames, each
 * carrying at least one diacritic so the folding axis is reachable.
 */
const JUDGE_NAMES = [
  "Jarmila Křížová",
  "Václav Doležal",
  "Květoslava Marešová",
  "Bohumír Šťastný",
  "Ludmila Nováková",
  "Radomír Čapek",
  "Zdeňka Hrubá",
  "Přemysl Vondráček",
  "Miloslava Řehořová",
  "Vojtěch Šimáček",
] as const;

const TITLES = [
  "JUDr.",
  "Mgr.",
  "Ing.",
  "prof.",
  "doc.",
  "PhDr.",
  "Ph.D.",
  "CSc.",
  "DrSc.",
  "LL.M.",
  "dr. h. c.",
] as const;

const judgeName = fc.constantFrom(...JUDGE_NAMES);
const titleRun = fc
  .array(fc.constantFrom(...TITLES), { maxLength: 3 })
  .map((titles) => titles.join(" "));

/** The same name with titles in front and behind, spaced arbitrarily. */
const titledName = fc
  .tuple(judgeName, titleRun, titleRun, fc.constantFrom(" ", "  ", " "))
  .map(([name, prefix, suffix, space]) =>
    [prefix, name, suffix === "" ? "" : `,${space}${suffix}`]
      .filter((part) => part !== "")
      .join(space),
  );

describe("judge match key", () => {
  test("keying a key returns it unchanged", () => {
    fc.assert(
      fc.property(titledName, (printed) => {
        const key = judgeNameKey(printed);

        expect(judgeNameKey(key)).toBe(key);
      }),
      config(300),
    );
  });

  test("the titles a publisher prints do not reach the key", () => {
    fc.assert(
      fc.property(judgeName, titleRun, titleRun, (name, prefix, suffix) => {
        const printed = [prefix, name, suffix]
          .filter((part) => part !== "")
          .join(" ");

        expect(judgeNameKey(printed)).toBe(judgeNameKey(name));
      }),
      config(300),
    );
  });

  test("a name keeps its key when the diacritics are dropped", () => {
    fc.assert(
      fc.property(judgeName, (name) => {
        const folded = stripDiacritics(name);

        // The fixture reaches the fault only if the two spellings differ.
        expect(folded).not.toBe(name);
        expect(judgeNameKey(folded)).toBe(judgeNameKey(name));
      }),
      config(100),
    );
  });

  test("the order the court printed the name in does not reach the key", () => {
    fc.assert(
      fc.property(judgeName, (name) => {
        const reversed = name.split(" ").toReversed().join(" ");

        // The fixture reaches the fault only if the two orders differ.
        expect(reversed).not.toBe(name);
        expect(judgeNameKey(reversed)).toBe(judgeNameKey(name));
      }),
      config(100),
    );
  });

  test("the record card's order and the roster's order agree", () => {
    expect(judgeNameKey("Novák Jan")).toBe(judgeNameKey("Jan Novák"));
  });

  test("two judges never share a key", () => {
    const keys = JUDGE_NAMES.map((name) => judgeNameKey(name));

    expect(new Set(keys).size).toBe(JUDGE_NAMES.length);
  });

  test("a key is lowercase, unaccented and hyphen-joined", () => {
    expect(judgeNameKey("JUDr. Jarmila Křížová, Ph.D.")).toBe(
      "jarmila-krizova",
    );
  });
});

describe("printed name without titles", () => {
  test("keeps the court's own spelling of the name", () => {
    expect(stripAcademicTitles("JUDr. Václav Doležal, CSc.")).toBe(
      "Václav Doležal",
    );
    expect(
      stripAcademicTitles("prof. JUDr. et Mgr. Zdeňka Hrubá, dr. h. c."),
    ).toBe("Zdeňka Hrubá");
    expect(stripAcademicTitles("Radomír Čapek")).toBe("Radomír Čapek");
  });

  test("removing titles from a stripped name changes nothing", () => {
    fc.assert(
      fc.property(titledName, (printed) => {
        const stripped = stripAcademicTitles(printed);

        expect(stripAcademicTitles(stripped)).toBe(stripped);
      }),
      config(300),
    );
  });
});
