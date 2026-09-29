import { describe, expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import {
  legislationNameMatchKey,
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

describe("legislationWorkNameForms", () => {
  test("stores the official title exactly as stated, and nothing derived in it", () => {
    const forms = legislationWorkNameForms(CORPORATIONS_TITLE);
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
    expect(derived(legislationWorkNameForms(CORPORATIONS_TITLE))).toEqual([
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
    expect(derived(legislationWorkNameForms(CODE_TITLE))).toEqual([
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
    const fromCitation = derived(
      legislationWorkNameForms(AMENDING_TITLE),
    ).filter((form) => form.derivation === "derived_from_citation");

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
      derived(legislationWorkNameForms(AMENDING_TITLE)).filter(
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
    expect(derived(legislationWorkNameForms(UNCITED_TITLE))).toEqual([
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
    expect(derived(legislationWorkNameForms("Constitution"))).toEqual([]);
  });
});

describe("planLegislationWorkNames", () => {
  const subject = {
    id: createSafeId<"legislationDocument">(),
    country: "CZE",
    title: CODE_TITLE,
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
