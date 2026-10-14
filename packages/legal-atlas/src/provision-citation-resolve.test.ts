import { describe, expect, test } from "bun:test";

import { CZ_PROFILE } from "./cz-provision-citation-profile";
import {
  type ActTitleSpec,
  formatWorkIdentifier,
} from "./provision-citation-profile";
import { resolveProvisionCitation } from "./provision-citation-resolve";

const TODAY = "2026-10-14";

const resolve = (text: string, citedOn = TODAY) =>
  resolveProvisionCitation({ text, profile: CZ_PROFILE, citedOn });

const resolved = (text: string, citedOn = TODAY) => {
  const result = resolve(text, citedOn);
  if (result.status !== "resolved") {
    throw new Error(`${text} did not resolve: ${result.status}`);
  }
  return result;
};

describe("resolveProvisionCitation", () => {
  test.each([
    "§ 316 odst. 2 ZP",
    "§316 odst.2 ZP",
    "§ 316 odst 2 ZP",
    "§ 316/2 ZP",
    "§ 316 odstavec 2 zákoníku práce",
    "ust. § 316 odst. 2 zákoníku práce",
    "ustanovení § 316 odst. 2 zák. práce",
    "§ 316 odst. 2 zákoníku práce",
    "§ 316 odst. 2 zakoniku prace",
    "§ 316 odst. 2 zákona č. 262/2006 Sb.",
    "262/2006 Sb. § 316 odst. 2",
    "§ 316 odst. 2 zákona 262/2006",
  ])("%s resolves to § 316 odst. 2 of the labour code", (text) => {
    expect(resolved(text)).toMatchObject({
      workIdentifier: "262/2006 Sb.",
      unit: "section",
      section: 316,
      sectionSuffix: null,
      subsection: "2",
      letter: null,
      point: null,
      anchor: "par_316-odst_2",
      citation: "§ 316 odst. 2 262/2006 Sb.",
    });
  });

  test("a letter, with or without its parenthesis, narrows below the subsection", () => {
    for (const text of [
      "§ 52 písm. g) zákoníku práce",
      "§ 52 písm g ZP",
      "§ 52 písmeno g) ZP",
    ]) {
      expect(resolved(text)).toMatchObject({
        section: 52,
        subsection: null,
        letter: "g",
        anchor: "par_52-pism_g",
      });
    }
  });

  test("a section without subdivisions asks for the whole section", () => {
    expect(resolved("§ 2910 OZ")).toMatchObject({
      workIdentifier: "89/2012 Sb.",
      section: 2910,
      subsection: null,
      anchor: "par_2910",
    });
  });

  test("a section suffix is kept and lowercased", () => {
    expect(resolved("§ 1a ZP")).toMatchObject({
      section: 1,
      sectionSuffix: "a",
      anchor: "par_1a",
    });
  });

  test("a recodified title names the act in force on the citing date", () => {
    expect(resolved("§ 420 občanského zákoníku", "2010-01-01")).toMatchObject({
      workIdentifier: "40/1964 Sb.",
    });
    expect(resolved("§ 2910 občanského zákoníku")).toMatchObject({
      workIdentifier: "89/2012 Sb.",
    });
  });

  test("an explicit gazette number wins over a title window", () => {
    expect(
      resolved("§ 420 zákona č. 40/1964 Sb., občanský zákoník"),
    ).toMatchObject({ workIdentifier: "40/1964 Sb." });
  });

  test("a sentence designator is read and dropped: anchors stop at points", () => {
    expect(resolved("§ 316 odst. 2 věta první ZP")).toMatchObject({
      anchor: "par_316-odst_2",
    });
  });

  test("an article citation reads the article unit", () => {
    expect(resolved("čl. 10 Listiny")).toMatchObject({
      unit: "article",
      section: 10,
      anchor: "cl_10",
    });
  });

  test("text without a section is refused as no provision", () => {
    expect(resolve("zákoník práce").status).toBe("no_provision");
    expect(resolve("kamerový systém na pracovišti").status).toBe(
      "no_provision",
    );
  });

  test.each([
    "§ 316 odst. 2 a 3 ZP",
    "§ 316 odst. 2, 3 ZP",
    "§ 316–318 ZP",
    "§ 316 - 318 ZP",
    "§ 316 až 318 ZP",
    "§§ 316 a 317 ZP",
    "§ 316 a § 317 ZP",
    "§ 52 písm. g) a h) ZP",
    "§ 2910 a násl. OZ",
    "§ 316 ZP a § 317 ZP",
    "§ 316 odst. 2, odst. 3 ZP",
    "§ 52 písm. g), písm. h) ZP",
    "§ 52 písm. g a h ZP",
    "§ 52 písm. g–h ZP",
    "§ 52 písm. g, h ZP",
    "§ 316 resp. 317 ZP",
    "§ 316 odst. 2 popř. odst. 3 ZP",
    "§ 52 písm. g respektive h ZP",
    "§ 316 odst. 2 ZP ve spojení s čl. 7 Listiny",
  ])(
    "%s names several provisions and is refused, never narrowed to the first",
    (text) => {
      expect(resolve(text).status).toBe("multiple_provisions");
    },
  );

  test("a name of another act beside a number is ambiguous; a name the act once bore is not", () => {
    const read = resolve("§ 10 ZP č. 89/2012 Sb.");
    expect(read.status).toBe("ambiguous_act");
    if (read.status === "ambiguous_act") {
      expect(
        read.candidates.map(({ workIdentifier }) => workIdentifier),
      ).toContain("89/2012 Sb.");
    }
    // The old civil code by number keeps its recodified title.
    expect(
      resolved("§ 420 zákona č. 40/1964 Sb., občanský zákoník"),
    ).toMatchObject({ workIdentifier: "40/1964 Sb." });
    expect(
      resolved("§ 316 zákona č. 262/2006 Sb., zákoník práce"),
    ).toMatchObject({ workIdentifier: "262/2006 Sb." });
  });

  test("two acts named by number are ambiguous, never the first", () => {
    const read = resolve("§ 10 zákona č. 89/2012 Sb. nebo č. 262/2006 Sb.");
    expect(read.status).toBe("ambiguous_act");
    if (read.status === "ambiguous_act") {
      expect(
        read.candidates.map(({ workIdentifier }) => workIdentifier).toSorted(),
      ).toEqual(["262/2006 Sb.", "89/2012 Sb."]);
    }
    // The same number twice is one act.
    expect(
      resolved("§ 316 zákona č. 262/2006 Sb. (zákon č. 262/2006 Sb.)"),
    ).toMatchObject({ workIdentifier: "262/2006 Sb." });
  });

  test("two acts named side by side are ambiguous, never resolved to the longer name", () => {
    const read = resolve("§ 10 občanského zákoníku nebo ZP");
    expect(read.status).toBe("ambiguous_act");
    if (read.status === "ambiguous_act") {
      expect(
        read.candidates.map(({ workIdentifier }) => workIdentifier).toSorted(),
      ).toEqual(["262/2006 Sb.", "89/2012 Sb."]);
    }
  });

  test("a shorter spelling inside a longer match is the same name, not a second act", () => {
    expect(resolved("§ 316 zákoníku práce")).toMatchObject({
      workIdentifier: "262/2006 Sb.",
    });
  });

  test("a lone letter after `a` is a preposition, not a second provision, unless a letter path continues", () => {
    expect(resolved("§ 316 odst. 2 a v souladu s tím ZP")).toMatchObject({
      section: 316,
      subsection: "2",
    });
  });

  test("an act named after a list-like word is still one provision", () => {
    // `a` joins the act's own words here, not a second provision.
    expect(
      resolved("§ 2910 zákona č. 89/2012 Sb., občanský zákoník"),
    ).toMatchObject({
      section: 2910,
      workIdentifier: "89/2012 Sb.",
    });
  });

  test("a section naming no act is refused as no act", () => {
    expect(resolve("§ 316 odst. 2").status).toBe("no_act");
    expect(resolve("§ 316 neznámého zákona").status).toBe("no_act");
  });

  test("a section in the wrong unit for its act is refused", () => {
    expect(resolve("§ 10 Listiny").status).toBe("unit_mismatch");
    // A gazette number the profile knows is checked against that act's unit.
    expect(resolve("§ 10 zákona č. 2/1993 Sb.").status).toBe("unit_mismatch");
    expect(resolved("čl. 10 č. 2/1993 Sb.")).toMatchObject({
      unit: "article",
      workIdentifier: "2/1993 Sb.",
    });
  });

  test("an alias is matched case-sensitively and as a whole word", () => {
    expect(resolve("§ 316 zp").status).toBe("no_act");
    expect(resolve("§ 316 ZPX").status).toBe("no_act");
  });
});

describe("every act spelling in the profile resolves", () => {
  // Enumerated from the profile itself, so a spelling added to it is covered
  // here without a new case.
  const entries: readonly ActTitleSpec[] = [
    ...CZ_PROFILE.aliases,
    ...CZ_PROFILE.titles,
  ];
  const cases = entries.flatMap((entry) =>
    entry.spellings.map((spelling) => ({ entry, spelling })),
  );

  test.each(cases)("$spelling", ({ entry, spelling }) => {
    const unit = entry.unit ?? "section";
    const term = unit === "article" ? "čl." : "§";
    // Read on a date the entry's window covers.
    const citedOn =
      entry.citedFrom ??
      (entry.citedUntil === undefined
        ? TODAY
        : `${String(Number(entry.citedUntil.slice(0, 4)) - 1)}-06-30`);
    const result = resolve(`${term} 5 odst. 1 ${spelling}`, citedOn);
    if (result.status === "ambiguous_act") {
      // A spelling two acts share on the same date is refused, never guessed.
      expect(
        result.candidates.map(({ workIdentifier }) => workIdentifier),
      ).toContain(formatWorkIdentifier(entry.identifier));
      return;
    }
    expect(result).toMatchObject({
      status: "resolved",
      unit,
      section: 5,
      subsection: "1",
    });
  });
});
