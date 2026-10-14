import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { CZ_PROFILE } from "./cz-provision-citation-profile";
import { locateProvisionCitations } from "./provision-citation-resolve";

const TODAY = "2026-10-14";

const locate = (text: string) =>
  locateProvisionCitations({ text, profile: CZ_PROFILE, citedOn: TODAY });

/** What each located span reads as, and what it resolved to. */
const located = (text: string) =>
  locate(text).map(({ start, end, citation }) => ({
    text: text.slice(start, end),
    work: citation.workIdentifier,
    section: citation.section,
    subsection: citation.subsection,
    letter: citation.letter,
  }));

describe("provisions cited in running text", () => {
  test("a provision named with its act by number, as an answer writes it", () => {
    expect(
      located(
        "Podle § 106 odst. 4 písm. e) zákona č. 262/2006 Sb. musí zaměstnavatel …",
      ),
    ).toEqual([
      {
        text: "§ 106 odst. 4 písm. e) zákona č. 262/2006 Sb.",
        work: "262/2006 Sb.",
        section: 106,
        subsection: "4",
        letter: "e",
      },
    ]);
  });

  test("a provision named by the act's abbreviation", () => {
    expect(
      located("Výpověď podle § 55 odst. 1 písm. b) ZP je možná, pokud …"),
    ).toEqual([
      {
        text: "§ 55 odst. 1 písm. b) ZP",
        work: "262/2006 Sb.",
        section: 55,
        subsection: "1",
        letter: "b",
      },
    ]);
  });

  test("a title that opens with a lead-in word is read as the title", () => {
    expect(located("dle § 52 písm. g) zákoníku práce.")).toEqual([
      {
        text: "§ 52 písm. g) zákoníku práce",
        work: "262/2006 Sb.",
        section: 52,
        subsection: null,
        letter: "g",
      },
    ]);
  });

  test("a title typed without diacritics is the same act", () => {
    expect(located("viz § 316 odst. 2 zakoniku prace")).toMatchObject([
      { text: "§ 316 odst. 2 zakoniku prace", work: "262/2006 Sb." },
    ]);
  });

  test("several provisions in one answer are each located, in order", () => {
    expect(
      located(
        "Srov. § 316 odst. 2 ZP a dále § 2910 občanského zákoníku; také čl. 10 Listiny.",
      ).map(({ text }) => text),
    ).toEqual([
      "§ 316 odst. 2 ZP",
      "§ 2910 občanského zákoníku",
      "čl. 10 Listiny",
    ]);
  });

  test("a provision without an act right after it is left unlinked", () => {
    expect(located("Podle § 316 odst. 2 je monitorování zakázáno.")).toEqual(
      [],
    );
    // An unrelated word between the provision and the act is not a lead-in.
    expect(located("§ 316 odst. 2 obecně ZP")).toEqual([]);
  });

  test("a span naming several provisions is left unlinked", () => {
    expect(located("§ 316 odst. 2 a 3 ZP")).toEqual([]);
    expect(located("§§ 2 až 4 ZP")).toEqual([]);
  });

  test("an unknown act name is left unlinked", () => {
    expect(located("§ 5 zákona o neexistujících věcech")).toEqual([]);
  });

  test(
    "a located span is exactly the citation, wherever it stands in the text",
    () => {
      const citation = fc.constantFrom(
        "§ 316 odst. 2 ZP",
        "§ 106 odst. 4 písm. e) zákona č. 262/2006 Sb.",
        "§ 52 písm. g) zákoníku práce",
        "čl. 10 Listiny",
      );
      const filler = fc
        .array(fc.constantFrom("x", "č", "🙂", " ", "\n", ",", "("), {
          maxLength: 40,
        })
        .map((parts) => parts.join(""));
      fc.assert(
        fc.property(filler, citation, filler, (prefix, printed, suffix) => {
          const text = `${prefix} ${printed}; ${suffix}`;
          const spans = locate(text);
          expect(spans).toHaveLength(1);
          const [span] = spans;
          expect(text.slice(span?.start, span?.end)).toBe(printed);
        }),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(10_000),
  );
});
