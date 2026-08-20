import { describe, expect, test } from "bun:test";

import type { CountryCode } from "@stll/country-codes";
import type {
  GeneratedTemplatePack,
  TemplatePackAuthor,
  TemplatePackSource,
} from "@stll/template-packs/schema";

import { rankTemplatePacks, toTemplatePackView } from "./catalogue";

const pack = ({
  id,
  name = id,
  jurisdictions = [],
  languages = [],
  templateJurisdictions = [],
  templateLanguages = [],
}: {
  id: string;
  name?: string;
  jurisdictions?: { country: string }[];
  languages?: string[];
  templateJurisdictions?: { country: string }[];
  templateLanguages?: string[];
}): GeneratedTemplatePack => ({
  id,
  name,
  version: "1.0.0",
  description: "",
  license: "CC0-1.0",
  licenseUrl: "https://example.invalid/license",
  source: SOURCE,
  authors: AUTHORS,
  jurisdictions,
  languages,
  legalAreas: [],
  lastReviewedAt: null,
  disclaimer: null,
  templates: [
    {
      slug: "only",
      title: "Only",
      file: "templates/only/template.docx",
      readmeFile: "templates/only/README.md",
      jurisdictions: templateJurisdictions,
      languages: templateLanguages,
      legalArea: null,
      license: "CC0-1.0",
      fields: [],
      sha256: "0".repeat(64),
      readme: "",
    },
  ],
});

const CZ = "CZ" as CountryCode;

const AUTHORS: TemplatePackAuthor[] = [
  { name: "Pack Drafter", organization: "Example Org", role: "drafter" },
  { name: "Pack Reviewer", role: "reviewer", date: "2026-01-10" },
];
const SOURCE: TemplatePackSource = {
  name: "Example source",
  url: "https://example.invalid/source",
  retrievedAt: "2026-01-15",
};

describe("template pack ranking", () => {
  test("practice jurisdictions rank first, agnostic packs before other jurisdictions", () => {
    const ranked = rankTemplatePacks(
      [
        pack({ id: "us-only", jurisdictions: [{ country: "US" }] }),
        pack({ id: "agnostic" }),
        pack({ id: "cz-pack", jurisdictions: [{ country: "CZ" }] }),
      ],
      { countries: [CZ], locale: null },
    );

    expect(ranked.map((view) => view.id)).toEqual([
      "cz-pack",
      "agnostic",
      "us-only",
    ]);
  });

  test("a template jurisdiction counts as the pack's, so an unlabelled pack still matches", () => {
    const view = toTemplatePackView(
      pack({ id: "mixed", templateJurisdictions: [{ country: "CZ" }] }),
      { countries: [CZ], locale: null },
    );

    expect(view.matchesJurisdiction).toBe(true);
  });

  test("language breaks ties on the primary subtag, not the full BCP-47 tag", () => {
    const ranked = rankTemplatePacks(
      [
        pack({ id: "a-english", languages: ["en"] }),
        pack({ id: "b-czech", languages: ["cs"] }),
      ],
      { countries: [], locale: "cs-CZ" },
    );

    expect(ranked.map((view) => view.id)).toEqual(["b-czech", "a-english"]);
    expect(ranked.map((view) => view.matchesLanguage)).toEqual([true, false]);
  });

  test("ranking is a total order on name then id, so an index cursor is stable", () => {
    const packs = [
      pack({ id: "second", name: "Shared name" }),
      pack({ id: "first", name: "Shared name" }),
    ];

    const forward = rankTemplatePacks(packs, { countries: [], locale: null });
    const reversed = rankTemplatePacks(packs.toReversed(), {
      countries: [],
      locale: null,
    });

    expect(forward.map((view) => view.id)).toEqual(["first", "second"]);
    expect(reversed.map((view) => view.id)).toEqual(forward.map((v) => v.id));
  });

  test("the view carries attribution and drops file paths", () => {
    const view = toTemplatePackView(pack({ id: "any" }), {
      countries: [],
      locale: null,
    });

    expect(view.authors).toEqual(AUTHORS);
    expect(view.source).toEqual(SOURCE);
    expect(view.licenseUrl).toBe("https://example.invalid/license");
    expect(view.templateCount).toBe(1);
    expect(view.templates.at(0)).toEqual({
      slug: "only",
      title: "Only",
      jurisdictions: [],
      languages: [],
      legalArea: null,
      license: "CC0-1.0",
      fields: [],
      sha256: "0".repeat(64),
    });
  });
});
