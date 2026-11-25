import { describe, expect, test } from "bun:test";

import {
  inferTemplateProfile,
  parseTemplateProfile,
  validateTemplateProfile,
} from "@/api/lib/templates/house-style/template-profile";
import {
  contractTemplate,
  LETTERHEAD,
  OUTLINE_LIST,
} from "@/api/lib/templates/house-style/template.test-helpers";

describe("inferTemplateProfile", () => {
  test("reads the outline list into heading, clause, letter and roman roles", () => {
    const { roles, spareLevels } = inferTemplateProfile(contractTemplate());
    expect(roles.articleHeading).toMatchObject({
      styleId: "Article",
      numbering: {
        numId: OUTLINE_LIST,
        ilvl: 0,
        numFmt: "decimal",
        lvlText: "Art. %1",
      },
    });
    expect(roles.clause1?.numbering).toMatchObject({ ilvl: 1 });
    expect(roles.clause2?.numbering).toMatchObject({ ilvl: 2 });
    expect(roles.clause3).toBeNull();
    expect(roles.letter?.numbering).toMatchObject({
      ilvl: 3,
      numFmt: "lowerLetter",
      lvlText: "%4)",
    });
    expect(roles.roman?.numbering).toMatchObject({ ilvl: 4 });
    // Levels no style uses are free to print what the roles' levels do not.
    expect(spareLevels.map(({ ilvl }) => ilvl)).toEqual([5, 6, 7, 8]);
  });

  test("reads unnumbered roles from style names and the sample text", () => {
    const { roles, annex, headings } = inferTemplateProfile(contractTemplate());
    expect(roles.title).toMatchObject({
      styleId: "Title",
      evidence: ["styleName", "sample"],
    });
    expect(roles.body?.styleId).toBe("Body");
    expect(roles.continuation?.styleId).toBe("Indent");
    // The numbered style heads a party; its details are written in the
    // style of the sample's detail lines.
    expect(roles.party).toMatchObject({ styleId: "Indent", numbering: null });
    expect(roles.recital?.numbering).toMatchObject({ numFmt: "upperLetter" });
    expect(roles.signature?.styleId).toBe("Signature");
    expect(roles.annexHeading).toMatchObject({
      styleId: "Annex",
      numbering: null,
    });
    expect(roles.bullet).toBeNull();
    expect(annex).toEqual({ numbering: "field" });
    expect(headings).toEqual({ article: "sameLine", annex: "lineBreak" });
  });

  test("a contents field that shows sample entries is not kept", () => {
    const filled = inferTemplateProfile(contractTemplate());
    expect(filled.regions.contents).toEqual([]);
    expect(filled.regions.keepBefore).toEqual([]);
    expect(filled.regions.filler).toContain("p5");

    const empty = inferTemplateProfile(contractTemplate({ contents: "empty" }));
    // The caption goes with the field, and the field is kept whole.
    expect(empty.regions.contents).toEqual(["p4", "p5", "p6", "p7"]);
    expect(empty.regions.filler).not.toContain("p5");
  });

  test("a table in front of the sample is kept; sample parties and signatures are slots", () => {
    const { regions, slots } = inferTemplateProfile(
      contractTemplate({ front: LETTERHEAD }),
    );
    expect(regions.keepBefore).toEqual(["t90"]);
    expect(slots.party).toEqual({ blockIds: ["p3"] });
    expect(slots.signature).toEqual({ blockIds: ["t13"] });
  });

  test("fields that prompt or change on open are frozen, the rest stay live", () => {
    const { fields, fillerStrings } = inferTemplateProfile(contractTemplate());
    expect(fields.freezeKinds).toEqual(["FILLIN", "TIME"]);
    expect(fields.liveKinds).toEqual([
      "AUTONUMLGL",
      "FILENAME",
      "PAGE",
      "PAGEREF",
      "TOC",
    ]);
    expect(fillerStrings).toEqual(["[company name]", "[…]", "[name]"]);
  });

  test("is deterministic and survives storage", () => {
    const inspection = contractTemplate();
    const profile = inferTemplateProfile(inspection);
    expect(inferTemplateProfile(inspection)).toEqual(profile);
    const stored: unknown = structuredClone(profile);
    expect(parseTemplateProfile(stored).unwrap()).toEqual(profile);
    expect(
      parseTemplateProfile({ ...profile, roles: { body: null } }).isErr(),
    ).toBe(true);
  });
});

describe("validateTemplateProfile", () => {
  const inspection = contractTemplate();
  const profile = inferTemplateProfile(inspection);

  test("an inferred profile fits its template", () => {
    expect(validateTemplateProfile(profile, inspection)).toEqual([]);
  });

  test("a profile of another template, or one naming what the template lacks, is an error", () => {
    const edited = {
      ...profile,
      templateSha256: "b".repeat(64),
      roles: {
        ...profile.roles,
        body: null,
        title: { ...profile.roles.title, styleId: "Gone" },
        clause1: {
          ...profile.roles.clause1,
          numbering: { ...profile.roles.clause1?.numbering, numId: 99 },
        },
      },
      regions: { ...profile.regions, keepBefore: ["p404"] },
    };
    const parsed = parseTemplateProfile(edited).unwrap();
    expect(
      validateTemplateProfile(parsed, inspection).map(
        ({ severity, code, role, blockId }) =>
          [severity, code, role ?? blockId ?? null] as const,
      ),
    ).toEqual([
      ["error", "templateMismatch", null],
      ["error", "missingBodyRole", "body"],
      ["error", "unknownStyle", "title"],
      ["error", "unknownListLevel", "clause1"],
      ["error", "unknownBlock", "p404"],
    ]);
  });

  test("a level whose format changed since the profile was confirmed is a warning", () => {
    const moved = contractTemplate();
    const outline = moved.numbering.abstractNums.at(-1);
    const first = outline?.levels.at(0);
    if (first !== undefined) {
      first.lvlText = "Article %1";
    }
    expect(validateTemplateProfile(profile, moved)).toEqual([
      { severity: "warning", code: "listLevelChanged", role: "articleHeading" },
    ]);
  });

  test("a contents field kept in part is an error", () => {
    const empty = contractTemplate({ contents: "empty" });
    const kept = inferTemplateProfile(empty);
    const split = {
      ...kept,
      regions: { ...kept.regions, contents: ["p5", "p6"] },
    };
    expect(validateTemplateProfile(split, empty)).toEqual([
      { severity: "error", code: "contentsFieldSplit", blockId: "p5" },
    ]);
  });
});
