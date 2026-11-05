import { describe, expect, test } from "bun:test";

import { statuteGazetteEliCollection } from "@stll/api-contract/statute-gazette";
import type { ActTitleSpec } from "@stll/legal-atlas/provision-citation-profile";
import { PROVISION_CITATION_PROFILES } from "@stll/legal-atlas/provision-citation-profiles";

import { createSafeId } from "@/api/lib/branded-types";
import {
  chooseNamedWorks,
  declinedTitleReference,
  legislationNameMatchKey,
  legislationNameQueryKeys,
  legislationWorkNameForms,
  planLegislationWorkNames,
} from "@/api/lib/legal-search/legislation-work-names";
import type { LegislationWorkNameForm } from "@/api/lib/legal-search/legislation-work-names";

/** Titles in the shapes the corpus stores them. */
const CODE_TITLE = "89/2012 Sb., občanský zákoník";
const CORPORATIONS_TITLE =
  "90/2012 Sb., o obchodních společnostech a družstvech (zákon o obchodních korporacích)";
const AMENDING_TITLE =
  "303/2013 Sb., kterým se mění některé zákony v souvislosti s přijetím rekodifikace soukromého práva, a zákona č. 235/2004 Sb., o dani z přidané hodnoty, ve znění pozdějších předpisů";
const UNCITED_TITLE = "Act on Public Procurement (Procurement Act), as amended";

const formsOf = (title: string) =>
  legislationWorkNameForms(title, { country: "CZE", documentType: null });

const derived = (forms: readonly LegislationWorkNameForm[]) =>
  forms.flatMap((form) =>
    form.origin === "derived"
      ? [
          {
            derivation: form.derivation,
            name: form.derivedName,
            citedKey:
              form.derivation === "derived_from_citation"
                ? form.citedKey
                : null,
          },
        ]
      : [],
  );

describe("legislationNameMatchKey", () => {
  test("folds case and punctuation, keeps diacritics", () => {
    expect(legislationNameMatchKey("  Občanský   zákoník. ")).toBe(
      "občanský zákoník",
    );
    expect(legislationNameMatchKey('"občanský zákoník"')).toBe(
      "občanský zákoník",
    );
    expect(legislationNameMatchKey("obcansky zakonik")).not.toBe(
      legislationNameMatchKey("občanský zákoník"),
    );
  });

  test("a bare number or nothing is not a name", () => {
    expect(legislationNameMatchKey("2012")).toBeNull();
    expect(legislationNameMatchKey(" ,; ")).toBeNull();
  });
});

/** 45/2013 Sb. as the corpus stores its title. */
const VICTIMS_TITLE =
  "45/2013 Sb., o obětech trestných činů a o změně některých zákonů (zákon o obětech trestných činů)";

describe("legislationNameQueryKeys", () => {
  test("a declined short title also reads as the nominative a stored title states", () => {
    const stated = formsOf(VICTIMS_TITLE).flatMap((form) =>
      form.origin === "derived" && form.derivation === "derived_parenthetical"
        ? [form.matchKey]
        : [],
    );
    expect(stated).toEqual(["zákon o obětech trestných činů"]);
    // The citation's own key misses the stored name; the declined head reads it.
    const own = legislationNameMatchKey("zákona o obětech trestných činů");
    expect(stated).not.toContain(own);
    const keys = legislationNameQueryKeys(
      "zákona o obětech trestných činů",
      "CZE",
    );
    expect(keys).toEqual([
      "zákona o obětech trestných činů",
      "zákon o obětech trestných činů",
    ]);
    for (const key of stated) {
      expect(keys).toContain(key);
    }
  });

  test("a query in the nominative, without a title head, or without a jurisdiction is its own key", () => {
    expect(
      legislationNameQueryKeys("zákon o obětech trestných činů", "CZE"),
    ).toEqual(["zákon o obětech trestných činů"]);
    expect(legislationNameQueryKeys("občanský zákoník", "cze")).toEqual([
      "občanský zákoník",
    ]);
    expect(
      legislationNameQueryKeys("zákona o obětech trestných činů", undefined),
    ).toEqual(["zákona o obětech trestných činů"]);
    expect(legislationNameQueryKeys("2012", "CZE")).toEqual([]);
  });
});

describe("declinedTitleReference", () => {
  const PROFILES = [
    ["cze", PROVISION_CITATION_PROFILES.CZE],
    ["svk", PROVISION_CITATION_PROFILES.SVK],
  ] as const;

  test("every declined short title a profile reads names its act, in any letter case", () => {
    for (const [country, profile] of PROFILES) {
      const titles: readonly ActTitleSpec[] = profile.titles;
      for (const spec of titles) {
        // A day inside the entry's window: its start, the end of the act's
        // year for a closed window without one, today for an open one.
        const citedOn =
          spec.citedFrom ??
          (spec.citedUntil === undefined
            ? "2026-11-02"
            : `${String(spec.identifier.year)}-12-31`);
        if (spec.citedUntil !== undefined && citedOn >= spec.citedUntil) {
          continue;
        }
        const expected = {
          country,
          collection: statuteGazetteEliCollection(spec.identifier.collection),
          number: String(spec.identifier.number),
          year: String(spec.identifier.year),
          label: null,
        };
        for (const spelling of spec.spellings) {
          for (const query of [
            spelling,
            spelling.toUpperCase(),
            ` ${spelling.replaceAll(" ", "  ")} `,
          ]) {
            expect({
              query,
              reference: declinedTitleReference(query, country, citedOn),
            }).toEqual({ query, reference: expected });
          }
        }
      }
    }
  });

  test("the reading date picks the act a recodified title named then", () => {
    expect(
      declinedTitleReference("občanského zákoníku", "cze", "2026-11-02"),
    ).toMatchObject({ number: "89", year: "2012", collection: "sb" });
    expect(
      declinedTitleReference("občanského zákoníku", "cze", "2010-01-01"),
    ).toMatchObject({ number: "40", year: "1964", collection: "sb" });
    expect(
      declinedTitleReference("Trestného zákona", "svk", "2026-11-02"),
    ).toMatchObject({ number: "300", year: "2005", collection: "zz" });
  });

  test("a title inside longer prose, an abbreviation or an unknown name names nothing", () => {
    for (const query of [
      "náhrada škody podle občanského zákoníku",
      "občanského zákoníku § 2910",
      "OZ",
      "zákona o něčem neznámém",
      "",
    ]) {
      expect(declinedTitleReference(query, "cze", "2026-11-02")).toBeNull();
    }
  });
});

describe("legislationWorkNameForms", () => {
  test("stores the official title exactly as stated, and nothing derived in it", () => {
    const forms = formsOf(CORPORATIONS_TITLE);
    const official = forms.filter((form) => form.origin === "official");

    expect(official).toEqual([
      {
        origin: "official",
        officialTitle: CORPORATIONS_TITLE,
        matchKey: legislationNameMatchKey(CORPORATIONS_TITLE),
      },
    ]);
    for (const form of forms) {
      if (form.origin === "derived") {
        expect(form).not.toHaveProperty("officialTitle");
      }
    }
  });

  test("derives the title's own name and its parenthesis, typed as derived", () => {
    expect(derived(formsOf(CORPORATIONS_TITLE))).toEqual([
      {
        derivation: "derived_title_segment",
        name: "o obchodních společnostech a družstvech (zákon o obchodních korporacích)",
        citedKey: null,
      },
      {
        derivation: "derived_parenthetical",
        name: "zákon o obchodních korporacích",
        citedKey: null,
      },
      {
        derivation: "derived_title_citation",
        name: "90/2012 Sb.",
        citedKey: null,
      },
    ]);
    expect(derived(formsOf(CODE_TITLE))).toEqual([
      {
        derivation: "derived_title_segment",
        name: "občanský zákoník",
        citedKey: null,
      },
      {
        derivation: "derived_title_citation",
        name: "89/2012 Sb.",
        citedKey: null,
      },
    ]);
  });

  test("an amending title names the act it cites, keyed to that citation", () => {
    const fromCitation = derived(formsOf(AMENDING_TITLE)).filter(
      (form) => form.derivation === "derived_from_citation",
    );

    // The name is written beside the cited citation, not the amending act's
    // own one, and the word before the citation gives the second form.
    expect(fromCitation).toEqual([
      {
        derivation: "derived_from_citation",
        name: "o dani z přidané hodnoty",
        citedKey: "235 2004 sb",
      },
      {
        derivation: "derived_from_citation",
        name: "zákona o dani z přidané hodnoty",
        citedKey: "235 2004 sb",
      },
    ]);
    // Its own name stops at the first clause, so the cited act's name is not
    // derived as the amending act's own.
    expect(
      derived(formsOf(AMENDING_TITLE)).filter(
        (form) => form.derivation === "derived_title_segment",
      ),
    ).toEqual([
      {
        derivation: "derived_title_segment",
        name: "kterým se mění některé zákony v souvislosti s přijetím rekodifikace soukromého práva",
        citedKey: null,
      },
    ]);
  });

  test("a title with no citation still yields its own name and parenthesis", () => {
    expect(derived(formsOf(UNCITED_TITLE))).toEqual([
      {
        derivation: "derived_title_segment",
        name: "Act on Public Procurement (Procurement Act)",
        citedKey: null,
      },
      {
        derivation: "derived_parenthetical",
        name: "Procurement Act",
        citedKey: null,
      },
    ]);
  });

  test("a title that is only its name adds no derived copy of it", () => {
    expect(derived(formsOf("Constitution"))).toEqual([]);
  });
});

describe("the names courts print", () => {
  const keysOf = (
    title: string,
    country: string,
    documentType: string | null,
  ) =>
    legislationWorkNameForms(title, { country, documentType }).flatMap(
      (form) => (form.matchKey === null ? [] : [form.matchKey]),
    );

  test.each([
    [
      "101/2000 Sb., o ochraně osobních údajů a o změně některých zákonů",
      "CZE",
      "zákon o ochraně osobních údajů",
    ],
    [
      "45/2013 Sb., o obětech trestných činů a o změně některých zákonů (zákon o obětech trestných činů)",
      "CZE",
      "zákon o obětech trestných činů",
    ],
    [
      "o obetiach trestných činov a o zmene a doplnení niektorých zákonov",
      "SVK",
      "zákon o obetiach trestných činov",
    ],
    ["85/1996 Sb., o advokacii", "CZE", "zákon o advokacii"],
    [
      "6/2002 Sb., o soudech, soudcích, přísedících a státní správě soudů a o změně některých dalších zákonů (zákon o soudech a soudcích)",
      "CZE",
      "zákon o soudech a soudcích",
    ],
  ])("%s names %s", (title, country, printed) => {
    expect(keysOf(title, country, "zákon")).toContain(printed);
  });

  test("a declined citation reads the head the publisher stated", () => {
    const stored = keysOf("85/1996 Sb., o advokacii", "CZE", "zákon");
    const read = legislationNameQueryKeys("zákona o advokacii", "cze");
    expect(read.filter((key) => stored.includes(key))).toEqual([
      "zákon o advokacii",
    ]);
  });

  test("a name cut at a comma never reads as a short title", () => {
    const stored = keysOf(
      "6/2002 Sb., o soudech, soudcích, přísedících a státní správě soudů",
      "CZE",
      "zákon",
    );
    expect(stored).not.toContain("zákon o soudech");
  });

  test("a decree is never named as a statute", () => {
    const stored = keysOf("177/1996 Sb., o X", "CZE", "vyhláška");
    expect(stored).toContain("vyhláška o x");
    expect(stored).not.toContain("zákon o x");
  });

  test("a kind the profile has no head for, or no profile, adds no head", () => {
    expect(keysOf("1/2000 Sb., o X", "CZE", "sdělení")).not.toContain(
      "sdělení o x",
    );
    expect(keysOf("o X", "AUT", "zákon")).not.toContain("zákon o x");
  });

  test("an amending title's closing parenthesis is not its own short title", () => {
    const title =
      "1/2000 Sb., kterým se mění zákon č. 90/2012 Sb., o obchodních společnostech a družstvech (zákon o obchodních korporacích)";
    const own = legislationWorkNameForms(title, {
      country: "CZE",
      documentType: "zákon",
    }).flatMap((form) =>
      form.origin === "derived" && form.derivation === "derived_parenthetical"
        ? [form.matchKey]
        : [],
    );
    expect(own).toEqual([]);
  });

  test("a parenthesis after a citation with no comma is the cited act's", () => {
    for (const title of [
      "1/2000 Sb., o X, kterým se mění zákon č. 90/2012 Sb. (zákon o obchodních korporacích)",
      "1/2000 Sb., kterým se mění zákon č. 90/2012 Sb. (zákon o obchodních korporacích)",
    ]) {
      const own = legislationWorkNameForms(title, {
        country: "CZE",
        documentType: "zákon",
      }).flatMap((form) =>
        form.origin === "derived" && form.derivation === "derived_parenthetical"
          ? [form.matchKey]
          : [],
      );
      expect(own).toEqual([]);
    }
  });

  test("a comma past the amending clause leaves the name whole", () => {
    expect(
      keysOf(
        "1/2000 Sb., o X a o změně zákona č. 5/1999 Sb., o Y",
        "CZE",
        "zákon",
      ),
    ).toEqual(expect.arrayContaining(["o x", "zákon o x"]));
  });

  test("planning twice over the same names changes nothing", () => {
    const subject = {
      id: createSafeId<"legislationDocument">(),
      country: "CZE",
      title:
        "101/2000 Sb., o ochraně osobních údajů a o změně některých zákonů",
      documentType: "zákon",
    };
    const first = planLegislationWorkNames([subject], []);
    const stored = first.inserts.map((row) => ({
      id: createSafeId<"legislationWorkName">(),
      documentId: subject.id,
      country: row.country,
      officialTitle: row.officialTitle ?? null,
      derivedName: row.derivedName ?? null,
      derivation: row.derivation ?? null,
      citedKey: row.citedKey ?? null,
      matchKey: row.matchKey ?? null,
    }));
    expect(planLegislationWorkNames([subject], stored).inserts).toEqual([]);
    expect(planLegislationWorkNames([subject], stored).deleteIds).toEqual([]);
  });
});

describe("chooseNamedWorks", () => {
  const own = { eli: "own", fromCitation: false };
  const cited = { eli: "cited", fromCitation: true };

  test("a corroborated Work outranks one whose title only carries the name", () => {
    expect(chooseNamedWorks([own, cited])).toEqual([cited]);
  });

  test("without a citation every Work stays a candidate", () => {
    expect(chooseNamedWorks([own])).toEqual([own]);
  });
});

describe("planLegislationWorkNames", () => {
  const subject = {
    id: createSafeId<"legislationDocument">(),
    country: "CZE",
    title: CODE_TITLE,
    documentType: null,
  };

  test("plans every name for a version with none stored", () => {
    const plan = planLegislationWorkNames([subject], []);

    expect(plan.deleteIds).toEqual([]);
    expect(plan.changedDocumentIds).toEqual([subject.id]);
    expect(
      plan.inserts.map((row) => row.officialTitle ?? row.derivedName),
    ).toEqual([CODE_TITLE, "občanský zákoník", "89/2012 Sb."]);
    // A derived name is never written to the official column.
    for (const row of plan.inserts) {
      expect(row.officialTitle === null).toBe(row.derivation !== null);
    }
  });

  test("plans nothing once the names are stored, and replaces a stale one", () => {
    const stored = planLegislationWorkNames([subject], []).inserts.map(
      (row) => ({
        id: createSafeId<"legislationWorkName">(),
        documentId: row.documentId,
        country: row.country,
        officialTitle: row.officialTitle ?? null,
        derivedName: row.derivedName ?? null,
        derivation: row.derivation ?? null,
        citedKey: row.citedKey ?? null,
        matchKey: row.matchKey ?? null,
      }),
    );

    expect(planLegislationWorkNames([subject], stored)).toEqual({
      inserts: [],
      deleteIds: [],
      changedDocumentIds: [],
    });

    const renamed = planLegislationWorkNames(
      [{ ...subject, title: "89/2012 Sb., zákoník" }],
      stored,
    );
    expect(
      renamed.inserts.map((row) => row.officialTitle ?? row.derivedName),
    ).toEqual(["89/2012 Sb., zákoník", "zákoník"]);
    expect(renamed.deleteIds).toHaveLength(2);
  });
});
