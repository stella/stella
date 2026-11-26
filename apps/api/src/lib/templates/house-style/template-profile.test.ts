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

    // A short line above the field that does not name the contents is
    // sample text of something else and is not kept with it.
    const uncaptioned = contractTemplate({ contents: "empty" });
    const above = uncaptioned.blocks.find(({ id }) => id === "p4");
    if (above !== undefined) {
      above.text = "[company name]";
    }
    expect(inferTemplateProfile(uncaptioned).regions.contents).toEqual([
      "p5",
      "p6",
      "p7",
    ]);
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

  test("a field over several blocks kept in part is an error, in whichever region", () => {
    const empty = contractTemplate({ contents: "empty" });
    const kept = inferTemplateProfile(empty);
    const inContents = {
      ...kept,
      regions: { ...kept.regions, contents: ["p5", "p6"] },
    };
    const inFront = {
      ...kept,
      regions: { ...kept.regions, contents: [], keepBefore: ["p5"] },
    };
    // Whole, but placed with its end in front of its start.
    const outOfOrder = {
      ...kept,
      regions: { ...kept.regions, contents: ["p5"], keepBefore: ["p6", "p7"] },
    };
    for (const split of [inContents, inFront, outOfOrder]) {
      expect(validateTemplateProfile(split, empty)).toEqual([
        { severity: "error", code: "fieldKeptInPart", blockId: "p5" },
      ]);
    }
  });

  const listStyle = (styleId: string, numId: number, ilvl: number) => ({
    styleId,
    name: styleId,
    type: "paragraph" as const,
    basedOn: "Normal",
    numPr: { numId, ilvl },
    outlineLvl: null,
    alignment: null,
    isDefault: false,
  });
  const listLevel = (
    ilvl: number,
    numFmt: string,
    lvlText: string,
    pStyle: string | null,
  ) => ({
    ilvl,
    numFmt,
    lvlText,
    start: 1,
    pStyle,
    indent: { left: null, hanging: null, firstLine: null },
  });

  test("the outline is the list the sample text is written in, not the one with most levels", () => {
    const template = contractTemplate();
    // A schedule list with seven styled levels that the sample never uses.
    template.numbering.abstractNums.push({
      abstractNumId: 9,
      levels: [
        listLevel(0, "none", "", "SchTitle"),
        listLevel(1, "none", "", "SchSubtitle"),
        listLevel(2, "decimal", "%3.", "SchNumber1"),
        listLevel(3, "decimal", "%3.%4", "SchNumber2"),
        listLevel(4, "lowerLetter", "(%5)", "SchNumber3"),
        listLevel(5, "lowerRoman", "(%6)", "SchNumber4"),
        listLevel(6, "decimal", "(%7)", "SchNumber5"),
      ],
    });
    template.numbering.nums.push({ numId: 30, abstractNumId: 9 });
    template.styles.push(
      listStyle("SchTitle", 30, 0),
      listStyle("SchSubtitle", 30, 1),
      listStyle("SchNumber1", 30, 2),
      listStyle("SchNumber2", 30, 3),
      listStyle("SchNumber3", 30, 4),
      listStyle("SchNumber4", 30, 5),
      listStyle("SchNumber5", 30, 6),
    );
    const { roles } = inferTemplateProfile(template);
    expect(roles.articleHeading).toMatchObject({ styleId: "Article" });
    expect(roles.clause1).toMatchObject({ styleId: "Clause1" });
    expect(roles.letter).toMatchObject({ styleId: "Letter" });
  });

  test("a level that prints nothing binds no role", () => {
    const template = contractTemplate();
    const outline = template.numbering.abstractNums.at(-1);
    const top = outline?.levels.at(0);
    if (top !== undefined) {
      top.numFmt = "none";
      top.lvlText = "";
    }
    const { roles } = inferTemplateProfile(template);
    const numbered = Object.values(roles).flatMap((role) =>
      role?.numbering ? [role.numbering] : [],
    );
    expect(numbered.length).toBeGreaterThan(0);
    expect(numbered.filter(({ numFmt }) => numFmt === "none")).toEqual([]);
    // The article style keeps its role, without a list, and the levels
    // below it are still the outline's clause depths.
    expect(roles.articleHeading).toMatchObject({
      styleId: "Article",
      numbering: null,
    });
    expect(roles.clause1).toMatchObject({ styleId: "Clause1" });
    expect(roles.clause2).toMatchObject({ styleId: "Clause2" });
  });

  test("an outline of an unnumbered heading and one counted level keeps both roles", () => {
    const template = contractTemplate();
    const outline = template.numbering.abstractNums.at(-1);
    if (outline !== undefined) {
      outline.levels = [
        listLevel(0, "none", "", "Article"),
        listLevel(1, "decimal", "%2.", "Clause1"),
      ];
    }
    const outlined = new Set(["Clause2", "Letter", "Roman"]);
    const { roles } = inferTemplateProfile({
      ...template,
      styles: template.styles.filter(({ styleId }) => !outlined.has(styleId)),
      blocks: template.blocks.filter(
        ({ styleId }) => styleId === null || !outlined.has(styleId),
      ),
    });
    expect(roles.articleHeading).toMatchObject({
      styleId: "Article",
      numbering: null,
    });
    expect(roles.clause1?.numbering).toMatchObject({ ilvl: 1, lvlText: "%2." });
  });

  test("clause depths are levels in a row: a counted level further down is not the next depth", () => {
    const template = contractTemplate();
    const outline = template.numbering.abstractNums.at(-1);
    // `1.`, `1.1.`, `1.1.1.`, then a lettered and a roman level, then two
    // counted levels that name every counter above them.
    outline?.levels.splice(
      6,
      2,
      listLevel(6, "decimal", "%1.%2.%3.%4.%5.%6.%7", "Deep7"),
      listLevel(7, "decimal", "%1.%2.%3.%4.%5.%6.%7.%8", "Deep8"),
    );
    template.styles.push(listStyle("Deep7", 18, 6), listStyle("Deep8", 18, 7));
    const { roles } = inferTemplateProfile(template);
    expect(roles.clause1?.numbering).toMatchObject({ ilvl: 1 });
    expect(roles.clause2?.numbering).toMatchObject({ ilvl: 2 });
    expect(roles.clause3).toBeNull();
    // Without the middle depth the chain ends at the first clause level.
    outline?.levels.splice(2, 1);
    const shallow = inferTemplateProfile({
      ...template,
      styles: template.styles.filter(({ styleId }) => styleId !== "Clause2"),
    });
    expect(shallow.roles.clause1?.numbering).toMatchObject({ ilvl: 1 });
    expect(shallow.roles.clause2).toBeNull();
    expect(shallow.roles.clause3).toBeNull();
  });

  test("the first clause depth stands directly under the heading", () => {
    const template = contractTemplate();
    const outline = template.numbering.abstractNums.at(-1);
    if (outline !== undefined) {
      // A lettered level between the heading and the counted level.
      outline.levels = [
        listLevel(0, "decimal", "Art. %1", "Article"),
        listLevel(1, "lowerLetter", "%2)", "Letter"),
        listLevel(2, "decimal", "%1.%3.", "Clause1"),
      ];
    }
    const dropped = new Set(["Clause2", "Roman"]);
    const { roles } = inferTemplateProfile({
      ...template,
      styles: template.styles
        .filter(({ styleId }) => !dropped.has(styleId))
        .map((style) => {
          if (style.styleId === "Letter") {
            return { ...style, numPr: { numId: 18, ilvl: 1 } };
          }
          return style.styleId === "Clause1"
            ? { ...style, numPr: { numId: 18, ilvl: 2 } }
            : style;
        }),
      blocks: template.blocks.filter(
        ({ styleId }) => styleId === null || !dropped.has(styleId),
      ),
    });
    expect(roles.articleHeading).toMatchObject({ styleId: "Article" });
    expect(roles.letter).toMatchObject({ styleId: "Letter" });
    expect(roles.clause1).toBeNull();
  });

  test("two styles on one level of the outline do not shift the clause depths", () => {
    const template = contractTemplate();
    template.styles.push({
      styleId: "Clause1Tight",
      name: "Clause 1.1 tight",
      type: "paragraph",
      basedOn: "Normal",
      numPr: { numId: 18, ilvl: 1 },
      outlineLvl: null,
      alignment: null,
      isDefault: false,
    });
    const { roles } = inferTemplateProfile(template);
    expect(roles.clause1).toMatchObject({ styleId: "Clause1" });
    expect(roles.clause2?.numbering).toMatchObject({ ilvl: 2 });
    expect(roles.clause3).toBeNull();
  });

  test("reports text that a 3-D scene showing nothing turns into a picture", () => {
    const template = contractTemplate();
    const level = (abstractNumId: number, ilvl: number) =>
      ({ kind: "level", abstractNumId, ilvl }) as const;
    const { health } = inferTemplateProfile({
      ...template,
      invisibleEffects: [
        { part: "word/numbering.xml", effect: "glow", owner: level(2, 0) },
        { part: "word/numbering.xml", effect: "scene3d", owner: level(2, 0) },
        { part: "word/numbering.xml", effect: "props3d", owner: level(2, 0) },
        { part: "word/numbering.xml", effect: "scene3d", owner: level(2, 3) },
        {
          part: "word/styles.xml",
          effect: "scene3d",
          owner: { kind: "style", styleId: "Title" },
        },
        {
          part: "word/styles.xml",
          effect: "shadow",
          owner: { kind: "style", styleId: "Body" },
        },
        {
          part: "word/styles.xml",
          effect: "scene3d",
          owner: { kind: "defaults" },
        },
        {
          part: "word/header1.xml",
          effect: "scene3d",
          owner: { kind: "text" },
        },
      ],
    });

    expect(health).toEqual([
      { kind: "numberDrawnAsPicture", abstractNumId: 2, ilvl: 0 },
      { kind: "numberDrawnAsPicture", abstractNumId: 2, ilvl: 3 },
      { kind: "textDrawnAsPicture", styleId: "Title" },
      { kind: "textDrawnAsPicture", styleId: null },
    ]);
    expect(inferTemplateProfile(template).health).toEqual([]);
  });

  test("finds a numbered level whose style sets it apart from its siblings", () => {
    const template = contractTemplate();
    const withLooks = (
      looks: Record<string, { bold: boolean; size: number | null }>,
    ) => ({
      ...template,
      styles: template.styles.map((style) => ({
        ...style,
        bold: false,
        size: 22,
        keepNext: false,
        ...looks[style.styleId],
      })),
    });
    // The second clause level in bold and a size up, under plain siblings.
    const apart = inferTemplateProfile(
      withLooks({
        Article: { bold: true, size: 22 },
        Clause2: { bold: true, size: 24 },
      }),
    );
    expect(apart.health).toEqual([
      {
        kind: "levelSetApart",
        role: "clause2",
        styleId: "Clause2",
        bold: true,
        size: 24,
        insteadStyleId: "Clause1",
      },
    ]);
    // The template's own target stays in the profile.
    expect(apart.roles.clause2?.styleId).toBe("Clause2");
    expect(parseTemplateProfile(apart).isOk()).toBe(true);

    // An item level takes an item's style.
    expect(
      inferTemplateProfile(withLooks({ Roman: { bold: false, size: 18 } }))
        .health,
    ).toMatchObject([{ role: "roman", insteadStyleId: "Letter" }]);
    // Levels that all look alike, a template that sets every level in
    // bold, and an inspection without the looks: nothing is found.
    expect(inferTemplateProfile(withLooks({})).health).toEqual([]);
    expect(
      inferTemplateProfile(
        withLooks({
          Clause1: { bold: true, size: 22 },
          Clause2: { bold: true, size: 22 },
          Letter: { bold: true, size: 22 },
          Roman: { bold: true, size: 22 },
          Body: { bold: true, size: 22 },
        }),
      ).health,
    ).toEqual([]);
    expect(inferTemplateProfile(template).health).toEqual([]);
    // Two looks with as many styles each (two plain clause styles, two
    // bold item styles, the body in a third size): no look is the
    // template's own, and nothing is found.
    expect(
      inferTemplateProfile(
        withLooks({
          Letter: { bold: true, size: 22 },
          Roman: { bold: true, size: 22 },
          Body: { bold: false, size: 20 },
        }),
      ).health,
    ).toEqual([]);
  });

  test("a finding that names a style the template lacks is refused", () => {
    const template = contractTemplate();
    const inferred = inferTemplateProfile(template);
    expect(
      validateTemplateProfile(
        {
          ...inferred,
          health: [
            {
              kind: "levelSetApart",
              role: "clause2",
              styleId: "Clause2",
              bold: true,
              size: 24,
              insteadStyleId: "Missing",
            },
          ],
        },
        template,
      ),
    ).toContainEqual({
      severity: "error",
      code: "unknownStyle",
      role: "clause2",
    });
  });

  test("lists the deeper levels of another list of the template for marks", () => {
    const template = contractTemplate();
    const withList = {
      ...template,
      numbering: {
        abstractNums: [
          ...template.numbering.abstractNums,
          {
            abstractNumId: 9,
            levels: [0, 1, 2].map((ilvl) => ({
              ilvl,
              numFmt: "decimal",
              lvlText: `%${String(ilvl + 1)}.`,
              start: 1,
              suff: "tab" as const,
              pStyle: null,
              indent: { left: 360 * (ilvl + 1), hanging: 360, firstLine: null },
            })),
          },
        ],
        nums: [...template.numbering.nums, { numId: 30, abstractNumId: 9 }],
      },
    };
    const listed = inferTemplateProfile(withList);
    expect(
      listed.markLevels?.map(({ numId, ilvl, abstractNumId }) => [
        numId,
        ilvl,
        abstractNumId,
      ]),
    ).toEqual([
      [30, 1, 9],
      [30, 2, 9],
    ]);
    expect(validateTemplateProfile(listed, withList)).toEqual([]);
    expect(parseTemplateProfile(listed).isOk()).toBe(true);
    expect(inferTemplateProfile(template).markLevels).toEqual([]);
  });

  test("a template with very many such findings still gives a profile that reads back", () => {
    const crowded = inferTemplateProfile({
      ...contractTemplate(),
      invisibleEffects: Array.from({ length: 2500 }, (_, index) => ({
        part: "word/numbering.xml",
        effect: "scene3d" as const,
        owner: {
          kind: "level" as const,
          abstractNumId: Math.floor(index / 9),
          ilvl: index % 9,
        },
      })),
    });

    expect(crowded.health).toHaveLength(2000);
    expect(parseTemplateProfile(crowded).isOk()).toBe(true);
  });
});
