import { describe, expect, test } from "bun:test";

import { CZ_PROFILE } from "./cz-provision-citation-profile";
import {
  type ActTitleSpec,
  formatWorkIdentifier,
} from "./provision-citation-profile";
import {
  anchorProvisionCitation,
  nominativeTitle,
  resolveActCitation,
  resolveProvisionCitation,
} from "./provision-citation-resolve";
import { SK_PROFILE } from "./sk-provision-citation-profile";

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
    "§ 316 odst. 2 ZP a odst. 3 ZP",
    "§ 316 odst. 2 ZP a 3 ZP",
    "§ 52 písm. g) ZP a h) ZP",
    "§ 2910 OZ a násl.",
    "§ 316 odst. 2 ZP, 3 ZP",
    "§ 316 ZP plus 317",
    "§ 316 ZP, 317 ZP",
    "§ 52 písm. g) ZP nebo písm. h) ZP",
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
    // A matching title does not excuse a conflicting name beside it.
    const mixed = resolve(
      "§ 10 zákona č. 89/2012 Sb., občanský zákoník nebo ZP",
    );
    expect(mixed.status).toBe("ambiguous_act");
    if (mixed.status === "ambiguous_act") {
      expect(
        mixed.candidates.map(({ workIdentifier }) => workIdentifier),
      ).toEqual(expect.arrayContaining(["89/2012 Sb.", "262/2006 Sb."]));
    }
    // The old civil code by number keeps its recodified title.
    expect(
      resolved("§ 420 zákona č. 40/1964 Sb., občanský zákoník"),
    ).toMatchObject({ workIdentifier: "40/1964 Sb." });
    expect(
      resolved("§ 316 zákona č. 262/2006 Sb., zákoník práce"),
    ).toMatchObject({ workIdentifier: "262/2006 Sb." });
  });

  test("a dated title does not hide an undated name of another act beside it", () => {
    const read = resolve("čl. 10 občanského zákoníku a Listiny");
    expect(read.status).toBe("ambiguous_act");
    if (read.status === "ambiguous_act") {
      expect(
        read.candidates.map(({ workIdentifier }) => workIdentifier),
      ).toEqual(expect.arrayContaining(["89/2012 Sb.", "2/1993 Sb."]));
    }
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

  test("a version date or year after the act is not another provision", () => {
    expect(
      resolved("§ 316 odst. 2 ZP ve znění účinném k 1. 1. 2020"),
    ).toMatchObject({
      section: 316,
      subsection: "2",
    });
    expect(resolved("§ 2910 OZ (stav k roku 2021)")).toMatchObject({
      section: 2910,
    });
    expect(resolved("§ 316 zákona č. 262/2006 Sb.")).toMatchObject({
      workIdentifier: "262/2006 Sb.",
    });
  });

  test("a later sentence designator refines the same provision", () => {
    expect(resolved("§ 316 odst. 2 ZP, věta druhá")).toMatchObject({
      section: 316,
      subsection: "2",
    });
    // A numbered sentence after the act is the same refinement, not a
    // further provision.
    expect(resolved("§ 316 odst. 2 ZP, věta 2")).toMatchObject({
      section: 316,
      subsection: "2",
    });
    expect(resolved("§ 316 odst. 2 ZP, větě 1")).toMatchObject({
      section: 316,
      subsection: "2",
    });
  });

  test("a sentence designator does not hide a further provision after it", () => {
    expect(resolve("§ 316 odst. 2 ZP, věta 2 a 3").status).toBe(
      "multiple_provisions",
    );
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

  test.each([
    "§ 11 odst. 1 písm. g) a. t.",
    "§ 11 odst. 1 písm. g) a.t.",
    "§ 11 odst. 1 písm. g) a. t",
    "§ 11 odst. 1 písm. g) advokátního tarifu",
  ])("%s names the attorney tariff", (text) => {
    expect(resolved(text)).toMatchObject({
      workIdentifier: "177/1996 Sb.",
      section: 11,
      subsection: "1",
      letter: "g",
    });
  });

  test("the attorney tariff abbreviation does not reach back before the tariff", () => {
    expect(resolve("§ 11 odst. 1 písm. g) a. t.", "1995-01-01").status).toBe(
      "no_act",
    );
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

describe("version years", () => {
  test("a year only counts as a version after version wording", () => {
    expect(resolve("§ 2910 OZ plus 2021").status).toBe("multiple_provisions");
    expect(resolve("§ 2910 OZ a 2012").status).toBe("multiple_provisions");
    expect(resolved("§ 2910 OZ ve znění z roku 2021")).toMatchObject({
      section: 2910,
    });
    expect(resolved("§ 2910 OZ (stav k roku 2021)")).toMatchObject({
      section: 2910,
    });
  });
});

describe("letters and canonical wording", () => {
  test("Czech `ch` is one letter, not `c` followed by more text", () => {
    expect(resolved("§ 10 písm. ch) ZP")).toMatchObject({
      section: 10,
      letter: "ch",
      citation: "§ 10 písm. ch) 262/2006 Sb.",
    });
    expect(resolved("§ 10 písm. ch) ZP").anchor).toEndWith("pism_ch");
    expect(resolve("§ 10 písm. h) a ch) ZP").status).toBe(
      "multiple_provisions",
    );
  });

  test("the canonical citation uses the jurisdiction's own designators", () => {
    const slovak = resolveProvisionCitation({
      text: "§ 2 ods. 1 zákona č. 311/2001 Z. z.",
      profile: SK_PROFILE,
      citedOn: TODAY,
    });
    expect(slovak).toMatchObject({
      status: "resolved",
      citation: "§ 2 ods. 1 311/2001 Z. z.",
    });
    expect(resolved("§ 2 odst. 1 zákona č. 262/2006 Sb.").citation).toBe(
      "§ 2 odst. 1 262/2006 Sb.",
    );
  });
});

describe("anchorProvisionCitation", () => {
  test.each([
    "§ 106 odst. 4 písm. e) ZP",
    "§ 52 písm. g) zákoníku práce",
    "§ 10 písm. ch) ZP",
    "§ 301 ZP",
    "§ 2 odst. 1 zákona č. 262/2006 Sb.",
  ])("%s reads back from its publisher anchor", (text) => {
    const { anchor, citation, workIdentifier } = resolved(text);
    expect(
      anchorProvisionCitation({ anchor, jurisdiction: "CZE", workIdentifier }),
    ).toBe(citation);
  });

  test("a Slovak anchor reads in its own scheme and designators", () => {
    const { anchor, citation, workIdentifier } = (() => {
      const result = resolveProvisionCitation({
        text: "§ 2 ods. 1 písm. a) zákona č. 311/2001 Z. z.",
        profile: SK_PROFILE,
        citedOn: TODAY,
      });
      if (result.status !== "resolved") {
        throw new Error(`Slovak citation did not resolve: ${result.status}`);
      }
      return result;
    })();
    expect(
      anchorProvisionCitation({ anchor, jurisdiction: "SVK", workIdentifier }),
    ).toBe(citation);
  });

  test("an anchor its scheme does not mint, or a jurisdiction without one, has none", () => {
    const workIdentifier = "262/2006 Sb.";
    for (const anchor of [
      "par_106-pism_e-odst_4",
      "par_",
      "par_106-",
      "heading-3",
      "paragraf-2.odsek-1",
    ]) {
      expect(
        anchorProvisionCitation({
          anchor,
          jurisdiction: "CZE",
          workIdentifier,
        }),
      ).toBeNull();
    }
    expect(
      anchorProvisionCitation({
        anchor: "par_2",
        jurisdiction: "XYZ",
        workIdentifier,
      }),
    ).toBeNull();
  });
});

/** III. ÚS 2900/26 (6 October 2026), each citation as the decision prints it. */
const CONSTITUTIONAL_COURT_ACT_CITATIONS = [
  {
    printed: "(§ 42 odst. 1 zákona o Ústavním soudu)",
    anchor: "par_42-odst_1",
  },
  {
    printed: "(které stanoví § 34 zákona o Ústavním soudu)",
    anchor: "par_34",
  },
  { printed: "(§ 30 odst. 1 zákona o Ústavním soudu", anchor: "par_30-odst_1" },
  {
    printed: "[§ 43 odst. 1 písm. a) zákona o Ústavním soudu]",
    anchor: "par_43-odst_1-pism_a",
  },
  {
    printed:
      "za přiměřeného použití § 43 odst. 1 písm. a) zákona o Ústavním soudu",
    anchor: "par_43-odst_1-pism_a",
  },
] as const;

const DECISION_DATE = "2026-10-06";

describe("a Constitutional Court decision's own citations", () => {
  test.each(CONSTITUTIONAL_COURT_ACT_CITATIONS)(
    "$printed",
    ({ printed, anchor }) => {
      expect(resolved(printed, DECISION_DATE)).toMatchObject({
        workIdentifier: "182/1993 Sb.",
        anchor,
      });
      expect(
        resolveActCitation({
          text: printed,
          profile: CZ_PROFILE,
          citedOn: DECISION_DATE,
        }),
      ).toEqual({
        status: "resolved",
        work: { number: 182, year: 1993, collection: "Sb." },
        workIdentifier: "182/1993 Sb.",
      });
    },
  );
});

describe("resolveActCitation", () => {
  const readAct = (text: string, citedOn = TODAY) =>
    resolveActCitation({ text, profile: CZ_PROFILE, citedOn });

  test("names an act with or without the provision printed before it", () => {
    for (const text of [
      "zákona o Ústavním soudu",
      "§ 43 odst. 1 písm. a) zákona o Ústavním soudu",
      "[§ 43 odst. 1 písm. a) zákona o Ústavním soudu]",
      "zákona č. 182/1993 Sb.",
    ]) {
      expect(readAct(text)).toMatchObject({
        status: "resolved",
        workIdentifier: "182/1993 Sb.",
      });
    }
    expect(readAct("čl. 36 odst. 1 Listiny")).toMatchObject({
      workIdentifier: "2/1993 Sb.",
    });
    expect(readAct("Ústavy")).toMatchObject({ workIdentifier: "1/1993 Sb." });
  });

  test("reads a recodified title for the citing date", () => {
    expect(readAct("občanského zákoníku", "2010-06-30")).toMatchObject({
      workIdentifier: "40/1964 Sb.",
    });
    expect(readAct("občanského zákoníku")).toMatchObject({
      workIdentifier: "89/2012 Sb.",
    });
  });

  test("hands back the act name, provision and brackets set aside, when the profile lists no such act", () => {
    // Zákon č. 45/2013 Sb., o obětech trestných činů: named by the short
    // title its own official title states in parentheses.
    expect(
      readAct("Z § 2 odst. 4 písm. b) zákona o obětech trestných činů"),
    ).toEqual({ status: "no_act", actName: "zákona o obětech trestných činů" });
    expect(
      readAct("[§ 2 odst. 4 písm. b) zákona o obětech trestných činů]"),
    ).toEqual({ status: "no_act", actName: "zákona o obětech trestných činů" });
  });

  test.each([
    "§ 2 zákona o obětech trestných činů, ve znění pozdějších předpisů",
    "§ 2 zákona o obětech trestných činů v platném znění",
    "§ 2 zákona o obětech trestných činů ve znění účinném do 31. 12. 2019",
  ])("%s names the act without its version statement", (text) => {
    expect(readAct(text)).toEqual({
      status: "no_act",
      actName: "zákona o obětech trestných činů",
    });
  });

  test("two named acts are refused, never guessed", () => {
    expect(readAct("zákoníku práce a zákona o Ústavním soudu").status).toBe(
      "ambiguous_act",
    );
  });
});

describe("nominativeTitle", () => {
  test.each([
    ["zákona o obětech trestných činů", "zákon o obětech trestných činů"],
    ["zákonem o obětech trestných činů", "zákon o obětech trestných činů"],
    ["zák. o obětech trestných činů", "zákon o obětech trestných činů"],
    ["Zákona o obětech trestných činů", "zákon o obětech trestných činů"],
    ["zákon o obětech trestných činů", "zákon o obětech trestných činů"],
    ["zákoníku práce", "zákoník práce"],
  ])("%s reads as %s", (name, nominative) => {
    expect(nominativeTitle(name, CZ_PROFILE)).toBe(nominative);
  });

  test("a name that opens with no title head, or is the head alone, has none", () => {
    expect(nominativeTitle("Listiny základních práv", CZ_PROFILE)).toBeNull();
    expect(nominativeTitle("zákona", CZ_PROFILE)).toBeNull();
    expect(nominativeTitle("unknown", CZ_PROFILE)).toBeNull();
  });

  test("Slovak heads decline in Slovak", () => {
    expect(nominativeTitle("zákonom o obetiach", SK_PROFILE)).toBe(
      "zákon o obetiach",
    );
    expect(nominativeTitle("zákonem o obetiach", SK_PROFILE)).toBeNull();
  });
});

describe("title heads", () => {
  test("every short title the profile spells `zákon o …` spells every head form", () => {
    // Listing the forms by hand is how one goes missing: `zákonu o
    // zaměstnanosti` once read as text.
    const [head] = CZ_PROFILE.titleHeads;
    expect(head.nominative).toBe("zákon");
    const titles: readonly ActTitleSpec[] = CZ_PROFILE.titles;
    const subjects = titles.flatMap(({ spellings }) =>
      spellings.flatMap((spelling) =>
        spelling.startsWith("zákon o ")
          ? [spelling.slice("zákon ".length)]
          : [],
      ),
    );
    expect(subjects).toContain("o Ústavním soudu");
    for (const subject of subjects) {
      const entry = titles.find(({ spellings }) =>
        spellings.includes(`zákon ${subject}`),
      );
      for (const form of head.forms) {
        expect(entry?.spellings).toContain(`${form} ${subject}`);
      }
    }
  });
});

describe("Slovak named acts", () => {
  test.each([
    "zákona o ústavnom súde",
    "zákon o ústavnom súde",
    "zákonu o ústavnom súde",
    "zákonom o ústavnom súde",
    "zákone o ústavnom súde",
    "zákona o Ústavnom súde Slovenskej republiky",
  ])("%s names the constitutional court act", (title) => {
    expect(
      resolveProvisionCitation({
        text: `§ 70 ods. 1 ${title}`,
        profile: SK_PROFILE,
        citedOn: TODAY,
      }),
    ).toMatchObject({
      status: "resolved",
      workIdentifier: "314/2018 Z. z.",
      anchor: "paragraf-70.odsek-1",
    });
  });

  test("the constitutional court short title follows its dated succession", () => {
    for (const [citedOn, workIdentifier] of [
      ["2019-02-28", "38/1993 Z. z."],
      ["2019-03-01", "314/2018 Z. z."],
    ] as const) {
      expect(
        resolveProvisionCitation({
          text: "§ 70 zákona o ústavnom súde",
          profile: SK_PROFILE,
          citedOn,
        }),
      ).toMatchObject({ status: "resolved", workIdentifier });
    }
    expect(
      resolveProvisionCitation({
        text: "§ 70 zákona č. 38/1993 Z. z. o ústavnom súde",
        profile: SK_PROFILE,
        citedOn: TODAY,
      }),
    ).toMatchObject({ status: "resolved", workIdentifier: "38/1993 Z. z." });
  });

  test("two acts with the same subject remain typed ambiguous", () => {
    const read = resolveProvisionCitation({
      text: "§ 2 zákona o spoločnej veci",
      profile: {
        ...SK_PROFILE,
        titles: [
          {
            spellings: ["zákona o spoločnej veci"],
            identifier: { number: 10, year: 2000, collection: "Z. z." },
          },
          {
            spellings: ["zákona o spoločnej veci"],
            identifier: { number: 20, year: 2001, collection: "Z. z." },
          },
        ],
      },
      citedOn: TODAY,
    });
    expect(read).toMatchObject({ status: "ambiguous_act" });
    if (read.status === "ambiguous_act") {
      expect(
        read.candidates.map(({ workIdentifier }) => workIdentifier).toSorted(),
      ).toEqual(["10/2000 Z. z.", "20/2001 Z. z."]);
    }
  });

  test("the Czech constitutional court title keeps its own identity", () => {
    expect(resolve("§ 70 odst. 1 zákona o Ústavním soudu")).toMatchObject({
      status: "resolved",
      workIdentifier: "182/1993 Sb.",
      anchor: "par_70-odst_1",
    });
  });
});

describe("Slovak registry spellings and provision spacing", () => {
  const entries: readonly ActTitleSpec[] = [
    ...SK_PROFILE.aliases,
    ...SK_PROFILE.titles,
  ];
  const cases = entries.flatMap((entry) =>
    entry.spellings.map((spelling) => ({ entry, spelling })),
  );
  test.each(cases)(
    "$spelling identifies its registered act",
    ({ entry, spelling }) => {
      const citedOn =
        entry.citedFrom ??
        (entry.citedUntil === undefined
          ? TODAY
          : `${String(Number(entry.citedUntil.slice(0, 4)) - 1)}-06-30`);
      const term = entry.unit === "article" ? "čl." : "§";
      for (const gap of ["", " "]) {
        const read = resolveProvisionCitation({
          text: `${term}${gap}5 ods.${gap}1 písm.${gap}a) bod${gap}2 ${spelling}`,
          profile: SK_PROFILE,
          citedOn,
        });
        expect(read).toMatchObject({
          status: "resolved",
          workIdentifier: formatWorkIdentifier(entry.identifier),
          section: 5,
          subsection: "1",
          letter: "a",
          point: "2",
        });
      }
    },
  );
});

test.each([
  "OSP",
  "O. s. p.",
  "Občiansky súdny poriadok",
  "Občianskeho súdneho poriadku",
  "Občianskom súdnom poriadku",
])("%s identifies the Slovak civil procedure code", (name) => {
  expect(
    resolveProvisionCitation({
      text: `§ 70 ods.1 ${name}`,
      profile: SK_PROFILE,
      citedOn: TODAY,
    }),
  ).toMatchObject({ status: "resolved", workIdentifier: "99/1963 Zb." });
});
