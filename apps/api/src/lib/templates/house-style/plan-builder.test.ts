import { describe, expect, test } from "bun:test";

import type {
  DocxBlock,
  DocxBlockManifest,
  DocxSection,
  TemplatePlan,
  TemplatePlanSourceItem,
} from "@/api/lib/templates/house-style/folio-contract";
import { buildLabelIndex } from "@/api/lib/templates/house-style/label-index";
import {
  blockIdOf,
  czechContract,
  czechDecimalContract,
  englishAgreement,
  germanContract,
  inColumns,
  manifestOf,
  numbered,
} from "@/api/lib/templates/house-style/manifest.test-helpers";
import {
  buildTemplatePlan,
  NO_EXCLUSIONS,
} from "@/api/lib/templates/house-style/plan-builder";
import type { NumberingMode } from "@/api/lib/templates/house-style/plan-numbering";
import { detectReferences } from "@/api/lib/templates/house-style/reference-detector";
import { findTopicSuspicions } from "@/api/lib/templates/house-style/reference-suspicions";
import {
  HOUSE_STYLE_ROLES,
  proposeBlockRoles,
} from "@/api/lib/templates/house-style/role-proposer";
import { inferTemplateProfile } from "@/api/lib/templates/house-style/template-profile";
import {
  contractTemplate,
  OUTLINE_LIST,
} from "@/api/lib/templates/house-style/template.test-helpers";

const PROFILE = inferTemplateProfile(contractTemplate());

type BuildOverrides = Partial<Parameters<typeof buildTemplatePlan>[0]>;

const build = (
  manifest: DocxBlockManifest,
  mode: NumberingMode = "keepSource",
  overrides: BuildOverrides = {},
) => {
  const index = buildLabelIndex(manifest);
  const { references } = detectReferences(manifest, index);
  return buildTemplatePlan({
    manifest,
    profile: PROFILE,
    references,
    roles: proposeBlockRoles({ manifest, index }),
    mode,
    index,
    suspicions: findTopicSuspicions({ manifest, index, references }),
    sourceHighlightColors: [],
    ...overrides,
  });
};

const sourceItems = ({ body }: TemplatePlan): TemplatePlanSourceItem[] =>
  body.flatMap((item) => (item.kind === "source" ? [item] : []));

const itemOf = (
  plan: TemplatePlan,
  manifest: DocxBlockManifest,
  start: string,
) =>
  sourceItems(plan).find(
    ({ blockId }) => blockId === blockIdOf(manifest, start),
  );

describe("buildTemplatePlan, keeping the source's numbering", () => {
  const manifest = czechContract("Viz čl. II odst. 2 písm. d) této smlouvy.");
  const { plan, note } = build(manifest);

  test("patches the template's levels to print the source's designators", () => {
    // The template sets number and title on one line, and the template
    // wins: the level stays as it is but for what it prints.
    expect(plan.numberingPatches).toContainEqual({
      abstractNumId: 4,
      ilvl: 0,
      numFmt: "upperRoman",
      lvlText: "Článek %1.",
    });
    // A template that leaves the break to the document: the document
    // breaks its headings after the number, so a space follows the number,
    // and the centred heading's level loses the indent that would move its
    // second line off the number's centre.
    const broken = build(manifest, "keepSource", {
      profile: {
        ...PROFILE,
        headings: { ...PROFILE.headings, article: "lineBreak" },
      },
    });
    expect(broken.plan.numberingPatches).toContainEqual({
      abstractNumId: 4,
      ilvl: 0,
      numFmt: "upperRoman",
      lvlText: "Článek %1.",
      suff: "space",
      indent: { left: 0, hanging: 0 },
    });
    // Paragraphs are numbered within their article: no article number.
    expect(plan.numberingPatches).toContainEqual({
      abstractNumId: 4,
      ilvl: 1,
      lvlText: "%2.",
    });
    // Letters and points already print as the template's levels do.
    expect(
      plan.numberingPatches?.filter(({ ilvl }) => ilvl === 3 || ilvl === 4),
    ).toEqual([]);
  });

  test("a typed label is stripped and a split heading joined", () => {
    expect(itemOf(plan, manifest, "SMLOUVA")).toEqual({
      kind: "source",
      blockId: "p0",
      hash: "h0",
      styleId: "Title",
      numbering: null,
    });
    const head = itemOf(plan, manifest, "Článek I.");
    expect(head).toMatchObject({
      styleId: "Article",
      numbering: { numId: OUTLINE_LIST, ilvl: 0 },
      stripLabel: "Článek I.",
      // On one line, as the template's sample heading reads.
      mergeNext: "none",
    });
    // The joined title is a bare item right after its heading.
    const items = sourceItems(plan);
    const position = head === undefined ? -1 : items.indexOf(head);
    expect(items[position + 1]).toEqual({
      kind: "source",
      blockId: blockIdOf(manifest, "Úvodní ustanovení"),
      hash: expect.any(String),
    });
    expect(itemOf(plan, manifest, "Článek II.")).not.toHaveProperty(
      "mergeNext",
    );
    // An automatic label is not text: nothing to strip.
    const clause = itemOf(plan, manifest, "První ujednání, oddíl II.");
    expect(clause).toMatchObject({
      styleId: "Clause1",
      numbering: { numId: OUTLINE_LIST, ilvl: 1 },
    });
    expect(clause).not.toHaveProperty("stripLabel");
    expect(itemOf(plan, manifest, "první podbod,")).toMatchObject({
      styleId: "Roman",
      numbering: { numId: OUTLINE_LIST, ilvl: 4 },
    });
  });

  test("references become fields that show what the source prints", () => {
    const citing = blockIdOf(manifest, "Viz čl. II");
    const text = "Viz čl. II odst. 2 písm. d) této smlouvy.";
    const fields = (plan.references ?? []).filter(
      ({ blockId }) => blockId === citing,
    );
    expect(
      fields.map(({ start, end, instruction, expectedText }) => [
        text.slice(start, end),
        expectedText,
        instruction,
      ]),
    ).toEqual([
      // The level text carries a word, which the field drops.
      ["II", "II", String.raw`\n \t \h`],
      ["2", "2", String.raw`\n \h`],
      ["d)", "d)", String.raw`\n \h`],
    ]);
    expect(fields.map(({ targetBlockId }) => targetBlockId)).toEqual([
      blockIdOf(manifest, "Článek II."),
      blockIdOf(manifest, "Druhé ujednání, oddíl II:"),
      blockIdOf(manifest, "čtvrtý případ"),
    ]);
    expect(plan.fields).toEqual({
      freezeKinds: ["FILLIN", "TIME"],
      updateOnOpen: true,
    });
    expect(note.counts.referencesLinked).toBe(plan.references?.length ?? 0);
  });

  test("an annex heading whose words carry punctuation stays typed text", () => {
    // A field would show `.2` for `Příloha č. 2`: the period of `č.` stays.
    const heading = itemOf(plan, manifest, "Příloha č. 2\nCeník");
    expect(heading).toMatchObject({ styleId: "Annex", numbering: null });
    expect(heading).not.toHaveProperty("stripLabel");
    expect(
      plan.numberingPatches?.some(({ lvlText }) =>
        lvlText?.includes("Příloha"),
      ),
    ).toBe(false);
    expect(note.items.filter(({ kind }) => kind.startsWith("label"))).toEqual(
      [],
    );
  });

  test("a reference to an annex whose number is typed stays text, under a reason of its own", () => {
    const typed = manifestOf([
      "SMLOUVA",
      "Článek I.\nPrvní",
      "1.1\tCeny jsou uvedeny v příloze č. 2 této smlouvy.",
      "Příloha č. 1\nSpecifikace",
      "Popis plnění.",
      "Příloha č. 2\nCeník",
      "Položky ceníku.",
    ]);
    const built = build(typed);
    expect(built.plan.references ?? []).toEqual([]);
    expect(built.note.items).toContainEqual(
      expect.objectContaining({
        kind: "referenceUnlinked",
        blockId: blockIdOf(typed, "1.1\t"),
        reason: "annexTyped",
      }),
    );
  });
});

describe("buildTemplatePlan, a number typed with a blank between its parts", () => {
  test("the paragraph joins the list, which prints the number closed up", () => {
    const spaced = manifestOf([
      "SMLOUVA",
      "1. Předmět smlouvy",
      "1. 1. Prodávající prodává zboží.",
      "1. 2. Kupující zboží kupuje podle odst. 1.1.",
    ]);
    const built = build(spaced);
    const first = itemOf(built.plan, spaced, "1. 1. ");
    expect(first).toMatchObject({ stripLabel: "1. 1." });
    expect(first?.numbering).not.toBeNull();
    expect(built.labelsNotKept).toEqual([]);
    expect(built.note.items).toContainEqual({
      kind: "numberPartsClosed",
      blocks: 2,
    });
    // The level is restated to print the number closed up: there is a
    // patch, and no level text of one holds a blank.
    const patches = built.plan.numberingPatches ?? [];
    expect(patches.length).toBeGreaterThan(0);
    expect(patches.some(({ lvlText }) => lvlText?.includes(" "))).toBe(false);
  });
});

describe("buildTemplatePlan, headings without a number", () => {
  const manifest = manifestOf([
    "SMLOUVA",
    "Článek I.\nPrvní",
    "1.1\tText ustanovení.",
    "Zvláštní ujednání",
    "Strany se dohodly na dalších podmínkách plnění.",
  ]);
  const heading = manifest.blocks.find(({ text }) =>
    text.startsWith("Zvláštní"),
  );
  if (heading !== undefined) {
    heading.alignment = "center";
  }

  test("take the template's style for them", () => {
    const body = PROFILE.roles.body;
    if (body === null) {
      throw new Error("fixture");
    }
    const { plan } = build(manifest, "keepSource", {
      profile: {
        ...PROFILE,
        roles: { ...PROFILE.roles, heading: { ...body, styleId: "Preamble" } },
      },
    });
    expect(itemOf(plan, manifest, "Zvláštní")).toMatchObject({
      styleId: "Preamble",
      numbering: null,
      keepNext: true,
    });
  });

  test("are text kept with what they head where the template has no such style", () => {
    const { plan } = build(manifest);
    expect(itemOf(plan, manifest, "Zvláštní")).toMatchObject({
      styleId: "Indent",
      keepNext: true,
    });
  });
});

describe("buildTemplatePlan, annexes a field numbers", () => {
  test("the heading keeps its text and its field, in the annex style and in no list", () => {
    const fielded = manifestOf([
      "SMLOUVA",
      "Článek I.\nPrvní",
      "1.1\tCeny jsou uvedeny v příloze č. 1 této smlouvy.",
      "Příloha č.  Ceník",
      "Položky ceníku.",
    ]);
    const heading = fielded.blocks.find(({ text }) =>
      text.startsWith("Příloha"),
    );
    if (heading === undefined) {
      throw new Error("fixture");
    }
    heading.selfNumbers = [11];
    const built = build(fielded);
    const item = itemOf(built.plan, fielded, "Příloha č.  Ceník");
    expect(item).toMatchObject({ styleId: "Annex", numbering: null });
    expect(item).not.toHaveProperty("stripLabel");
    expect(item).not.toHaveProperty("labelAsText");
    expect(
      built.note.items.filter(
        (noted) =>
          noted.kind.startsWith("label") &&
          "blockId" in noted &&
          noted.blockId === heading.id,
      ),
    ).toEqual([]);
    // No field can cite a number that a field of the text counts.
    expect(built.plan.references ?? []).toEqual([]);
    expect(built.note.items).toContainEqual(
      expect.objectContaining({
        kind: "referenceUnlinked",
        blockId: blockIdOf(fielded, "1.1\t"),
        reason: "annexTyped",
      }),
    );
  });
});

describe("buildTemplatePlan, annexes a field can cite", () => {
  const manifest = englishAgreement("See Clause 2.3(a) and Annex 2.");
  const { plan } = build(manifest);

  test("an annex heading in plain words takes a spare level and is linked", () => {
    expect(itemOf(plan, manifest, "Annex 2\nCharges Table")).toMatchObject({
      styleId: "Annex",
      stripLabel: "Annex 2",
      numbering: { numId: OUTLINE_LIST, ilvl: 5 },
    });
    expect(plan.numberingPatches).toContainEqual({
      abstractNumId: 4,
      ilvl: 5,
      numFmt: "decimal",
      lvlText: "Annex %6",
    });
    expect(plan.references).toContainEqual(
      expect.objectContaining({
        targetBlockId: blockIdOf(manifest, "Annex 2\nCharges Table"),
        expectedText: "2",
        instruction: String.raw`\n \t \h`,
      }),
    );
  });
});

describe("buildTemplatePlan, list instances", () => {
  test("a number that is not the next one opens an instance the list then stays in", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I.\nPrvní",
      numbered("1.", "Odstavec:", 1),
      numbered("a)", "případ;", 2),
      numbered("b)", "případ.", 2),
      "Pokračování odstavce, po němž výčet začíná znovu:",
      numbered("a)", "případ;", 3),
      numbered("2.", "Odstavec.", 1),
      "Článek III.\nTřetí, druhý článek chybí",
      numbered("1.", "Odstavec.", 4),
      numbered("5.", "Odstavec s přeskočeným číslem.", 4),
      numbered("6.", "Odstavec.", 4),
    ]);
    const { plan } = build(manifest);
    const list = { numId: OUTLINE_LIST };
    expect(sourceItems(plan).map(({ numbering }) => numbering)).toEqual([
      null,
      { ...list, ilvl: 0 },
      { ...list, ilvl: 1 },
      { ...list, ilvl: 3 },
      { ...list, ilvl: 3 },
      null,
      { ...list, ilvl: 3, restartFrom: 1, group: "list4-1" },
      { ...list, ilvl: 1, group: "list4-1" },
      { ...list, ilvl: 0, restartFrom: 3, group: "list4-2" },
      { ...list, ilvl: 1, group: "list4-2" },
      { ...list, ilvl: 1, restartFrom: 5, group: "list4-3" },
      { ...list, ilvl: 1, group: "list4-3" },
    ]);
  });

  test("a heading broken behind its number is set on one line, as the template sets its headings", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I. První",
      numbered("1.", "Odstavec.", 1),
      "Článek II. Druhý",
      numbered("1.", "Odstavec.", 2),
      "Článek III.\nTřetí, jako jediný zalomený",
      numbered("1.", "Odstavec.", 3),
    ]);
    const { plan, note } = build(manifest);
    // The break goes with the typed number: nothing is left to move a
    // second line off the centre, so the level keeps its indent.
    expect(itemOf(plan, manifest, "Článek III.")).toMatchObject({
      stripLabel: "Článek III.",
      stripLabelBreak: true,
    });
    expect(itemOf(plan, manifest, "Článek I.")).not.toHaveProperty(
      "stripLabelBreak",
    );
    expect(plan.numberingPatches).toContainEqual({
      abstractNumId: 4,
      ilvl: 0,
      numFmt: "upperRoman",
      lvlText: "Článek %1.",
    });
    expect(note.items).toContainEqual({
      kind: "headingBreaksDropped",
      blocks: 1,
    });
    // Where the template leaves the break to the document, one heading
    // with a break is enough to take the centred level's indent away.
    const kept = build(manifest, "keepSource", {
      profile: {
        ...PROFILE,
        headings: { ...PROFILE.headings, article: "lineBreak" },
      },
    });
    expect(kept.plan.numberingPatches).toContainEqual({
      abstractNumId: 4,
      ilvl: 0,
      numFmt: "upperRoman",
      lvlText: "Článek %1.",
      indent: { left: 0, hanging: 0 },
    });
    expect(itemOf(kept.plan, manifest, "Článek III.")).not.toHaveProperty(
      "stripLabelBreak",
    );
  });

  test("a spare level takes a first-line indent of the level it stands in for", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I.\nPrvní",
      numbered("1.", "Odstavec:", 1),
      numbered("a)", "případ;", 2),
      numbered("(a)", "případ psaný jinak;", 3),
    ]);
    const profile = structuredClone(PROFILE);
    const letter = profile.roles.letter?.numbering;
    if (letter) {
      letter.indent = { left: 2268, hanging: null, firstLine: 284 };
    }
    const { plan } = build(manifest, "keepSource", { profile });
    expect(plan.numberingPatches).toContainEqual({
      abstractNumId: 4,
      ilvl: 5,
      numFmt: "lowerLetter",
      indent: { left: 2268, firstLine: 284 },
    });
  });

  test("a spare level that numbers a role without a level of its own takes the indent of the level whose style it borrows", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I.\nPrvní",
      numbered("1.", "Odstavec.", 1),
      numbered("1.1.", "Pododstavec.", 2),
      numbered("1.1.1.", "Podrobnost.", 3),
    ]);
    const { plan } = build(manifest);
    const second = PROFILE.roles.clause2?.numbering;
    const detail = itemOf(plan, manifest, "Podrobnost");
    expect(PROFILE.roles.clause3).toBeNull();
    expect(detail).toMatchObject({ styleId: "Clause2" });
    expect(
      plan.numberingPatches?.find(
        ({ ilvl }) => ilvl === detail?.numbering?.ilvl,
      )?.indent,
    ).toEqual({
      left: second?.indent.left ?? 0,
      hanging: second?.indent.hanging ?? 0,
    });
  });

  test("bullets hang from the paragraph in front of their list, a level for each indent", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      "Úvodní věta s výčtem:",
      numbered("•", "odrážka pod úvodní větou", 4),
      "Článek I.\nPrvní",
      numbered("1.", "Odstavec s výčtem:", 1),
      numbered("•", "odrážka pod odstavcem", 5),
      numbered("•", "druhá odrážka pod odstavcem", 5),
    ]);
    const { plan } = build(manifest);
    const levelOf = (start: string) =>
      plan.numberingPatches?.find(
        ({ ilvl }) => ilvl === itemOf(plan, manifest, start)?.numbering?.ilvl,
      );
    const clauseText = PROFILE.roles.clause1?.numbering?.indent.left ?? 0;
    const step = PROFILE.roles.letter?.numbering?.indent.hanging ?? 0;
    expect(step).toBeGreaterThan(0);
    // Under text at the margin the mark stands at the margin.
    expect(levelOf("odrážka pod úvodní")?.indent).toEqual({
      left: step,
      hanging: step,
    });
    // Under a clause it stands where the clause's text starts.
    expect(levelOf("odrážka pod odstavcem")?.indent).toEqual({
      left: clauseText + step,
      hanging: step,
    });
    expect(levelOf("druhá odrážka")).toBe(levelOf("odrážka pod odstavcem"));
  });

  test("a bullet takes a level outside the outline list where the template has one", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I.\nPrvní",
      numbered("1.", "Odstavec:", 1),
      numbered("•", "odrážka", 4),
      numbered("(a)", "případ psaný jinak;", 3),
    ]);
    const markLevel = {
      numId: 20,
      ilvl: 1,
      abstractNumId: 3,
      numFmt: "decimal",
      lvlText: "%2.",
      start: 1,
      indent: { left: 720, hanging: 360, firstLine: null },
    };
    const { plan } = build(manifest, "keepSource", {
      profile: { ...PROFILE, markLevels: [markLevel] },
    });
    expect(itemOf(plan, manifest, "odrážka")?.numbering).toMatchObject({
      numId: 20,
      ilvl: 1,
    });
    expect(plan.numberingPatches).toContainEqual(
      expect.objectContaining({
        abstractNumId: 3,
        ilvl: 1,
        numFmt: "bullet",
        lvlText: "•",
      }),
    );
    // No level of the outline list is patched for the bullet.
    expect(
      plan.numberingPatches?.some(({ numFmt }) => numFmt === "bullet") &&
        plan.numberingPatches.every(
          ({ abstractNumId, numFmt }) =>
            numFmt !== "bullet" || abstractNumId === 3,
        ),
    ).toBe(true);
  });

  test("a second format of one level and a bullet take spare levels", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I.\nPrvní",
      numbered("1.", "Odstavec:", 1),
      numbered("a)", "případ;", 2),
      numbered("b)", "případ;", 2),
      numbered("(a)", "případ psaný jinak;", 3),
      numbered("•", "odrážka", 4),
    ]);
    const { plan, note } = build(manifest);
    expect(itemOf(plan, manifest, "případ psaný jinak")).toMatchObject({
      styleId: "Letter",
      numbering: { ilvl: 5 },
    });
    expect(itemOf(plan, manifest, "odrážka")).toMatchObject({
      styleId: "Indent",
      numbering: { ilvl: 6 },
    });
    expect(plan.numberingPatches).toEqual(
      expect.arrayContaining([
        // The spare level already prints brackets; its format moves, and
        // it takes the indent of the letter level it stands in for.
        {
          abstractNumId: 4,
          ilvl: 5,
          numFmt: "lowerLetter",
          indent: { left: 2268, hanging: 567 },
        },
        // The bullet hangs from the text of the item in front of it.
        {
          abstractNumId: 4,
          ilvl: 6,
          numFmt: "bullet",
          lvlText: "•",
          indent: { left: 2835, hanging: 567 },
        },
      ]),
    );
    expect(note.items.filter(({ kind }) => kind.startsWith("label"))).toEqual(
      [],
    );
  });

  test("a label no level can print stays text and its paragraph joins no list", () => {
    // Dotted paragraphs under roman articles: the level would print II.1.
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I.\nPrvní",
      "1.1\tOdstavec prvního článku.",
      "Článek II.\nDruhý",
      "2.1\tOdstavec druhého článku, viz čl. 1.1 této smlouvy.",
    ]);
    const { plan, note } = build(manifest);
    const clause = itemOf(plan, manifest, "1.1\t");
    expect(clause).toMatchObject({ styleId: "Clause1", numbering: null });
    expect(clause).not.toHaveProperty("stripLabel");
    expect(note.items).toContainEqual({
      kind: "labelKeptAsText",
      blockId: blockIdOf(manifest, "1.1\t"),
      reason: "formatConflict",
    });
    // No field can show the number of a paragraph that is not numbered.
    expect(plan.references ?? []).toEqual([]);
    expect(note.items).toContainEqual(
      expect.objectContaining({
        kind: "referenceUnlinked",
        reason: "targetNotNumbered",
        highlighted: false,
      }),
    );
  });
});

describe("buildTemplatePlan, automatic labels no list prints", () => {
  const manifest = manifestOf([
    "SMLOUVA",
    "Článek I.\nPrvní",
    numbered("1.", "Odstavec.", 1),
    // Composite labels this reader cannot restate as a level text.
    numbered("I. 1)", "Bod se složeným označením.", 2),
    numbered("I. 2)", "Další bod se složeným označením.", 2),
    "Závěrečná věta.",
  ]);
  const composite = blockIdOf(manifest, "Bod se složeným");

  for (const mode of ["keepSource", "houseScheme"] as const) {
    test(`are written as text and reported (${mode})`, () => {
      const { plan, note, labelsNotKept } = build(manifest, mode);
      expect(itemOf(plan, manifest, "Bod se složeným")).toMatchObject({
        numbering: null,
        labelAsText: true,
      });
      expect(itemOf(plan, manifest, "Další bod")).toMatchObject({
        numbering: null,
        labelAsText: true,
      });
      // A numbered paragraph and one without a label take no label text.
      expect(itemOf(plan, manifest, "Odstavec.")).not.toHaveProperty(
        "labelAsText",
      );
      expect(itemOf(plan, manifest, "Závěrečná")).not.toHaveProperty(
        "labelAsText",
      );
      expect(note.items).toContainEqual({
        kind: "labelConvertedToText",
        blockId: composite,
        reason: "unreadable",
      });
      expect(note.counts.labelsConvertedToText).toBe(2);
      expect(labelsNotKept).toEqual([]);
    });
  }

  test("a bullet keeps its mark on a spare level under the house scheme too", () => {
    const bulleted = manifestOf([
      "SMLOUVA",
      "Článek I.\nPrvní",
      numbered("1.", "Odstavec s výčtem:", 1),
      numbered("-", "první položka", 5),
      numbered("-", "druhá položka", 5),
    ]);
    for (const mode of ["keepSource", "houseScheme"] as const) {
      const { plan, labelsNotKept } = build(bulleted, mode);
      const item = itemOf(plan, bulleted, "první položka");
      expect(item).not.toHaveProperty("labelAsText");
      const numbering = item?.numbering ?? null;
      expect(numbering).not.toBeNull();
      expect(plan.numberingPatches).toContainEqual(
        expect.objectContaining({
          ilvl: numbering?.ilvl,
          numFmt: "bullet",
          lvlText: "-",
        }),
      );
      expect(labelsNotKept).toEqual([]);
    }
  });

  test("a numbered cell placed with its table keeps its number as text", () => {
    const table = inColumns(2, [
      numbered("I. 1)", "Položka", 7),
      "12 ks",
      numbered("I. 2)", "Další položka", 7),
      "3 ks",
    ]);
    const { plan, labelsNotKept } = build(table);
    const nested = sourceItems(plan).at(0)?.nested ?? [];
    expect(nested.filter(({ labelAsText }) => labelAsText === true)).toEqual([
      { blockId: "p0", numbering: null, labelAsText: true },
      { blockId: "p2", numbering: null, labelAsText: true },
    ]);
    expect(labelsNotKept).toEqual([]);
  });

  test("every label of a contract is printed by a list or written as text", () => {
    for (const contract of [
      czechContract("Viz čl. II odst. 2 této smlouvy."),
      czechDecimalContract("Viz čl. 2.1 této smlouvy."),
      englishAgreement("See Section 2.1 hereof."),
      germanContract("Siehe § 2 Abs. 1 dieses Vertrages."),
    ]) {
      for (const mode of ["keepSource", "houseScheme"] as const) {
        expect(build(contract, mode).labelsNotKept).toEqual([]);
      }
    }
  });
});

describe("buildTemplatePlan, pages the source starts", () => {
  /** A manifest of paragraphs with the break facts given by position. */
  const withFacts = (
    texts: readonly string[],
    facts: Readonly<Record<number, Partial<DocxBlock>>>,
    sections?: DocxSection[],
  ): DocxBlockManifest => {
    const manifest = manifestOf(texts);
    return {
      ...manifest,
      blocks: manifest.blocks.map((block, position) => ({
        ...block,
        ...facts[position],
      })),
      ...(sections === undefined ? {} : { sections }),
    };
  };
  const section = (
    index: number,
    start: DocxSection["start"],
    orientation: DocxSection["orientation"] = "portrait",
  ): DocxSection => ({
    index,
    start,
    orientation,
    size:
      orientation === "portrait"
        ? { width: 11_906, height: 16_838 }
        : { width: 16_838, height: 11_906 },
    margins: { top: 1417, right: 1417, bottom: 1417, left: 1417 },
    columns: 1,
  });
  const starts = (plan: TemplatePlan): string[] =>
    sourceItems(plan)
      .filter(({ pageBreakBefore }) => pageBreakBefore === true)
      .map(({ blockId }) => blockId);
  const notes = (
    note: ReturnType<typeof build>["note"],
    kind: "pageStartNotKept" | "sectionLayoutNotKept",
  ) => note.items.filter((item) => item.kind === kind);

  test("a page break in a blank paragraph that is left out starts the next paragraph's page", () => {
    const { plan, note } = build(
      withFacts(["SMLOUVA", "Text.", "", "Příloha č. 1", "Seznam."], {
        2: { pageBreaks: 1 },
      }),
    );
    expect(plan.omit).toEqual([{ blockId: "p2", reason: "empty" }]);
    expect(starts(plan)).toEqual(["p3"]);
    expect(note.counts.pageStarts).toBe(1);
  });

  test("a page start between an article's heading and its text moves in front of the heading", () => {
    const { plan, note } = build(
      withFacts(
        [
          "SMLOUVA",
          "Článek I. Předmět",
          "První ujednání.",
          "Článek II. Cena",
          "",
          "Druhé ujednání.",
        ],
        { 4: { pageBreaks: 1 } },
      ),
    );
    expect(starts(plan)).toEqual(["p3"]);
    expect(note.items.filter(({ kind }) => kind === "pageStartMoved")).toEqual([
      { kind: "pageStartMoved", blockId: "p3", fromBlockId: "p5" },
    ]);
    expect(note.counts.pageStarts).toBe(1);
  });

  test("a page start behind running text numbered like an article stays where it is", () => {
    const { plan, note } = build(
      withFacts(
        [
          "SMLOUVA",
          "1.\tStrany se dohodly, že veškeré informace, které si předají, zůstanou důvěrné po dobu pěti let.",
          "Příloha č. 1",
        ],
        { 2: { pageBreakBefore: true } },
      ),
    );
    expect(starts(plan)).toEqual(["p2"]);
    expect(note.items.some(({ kind }) => kind === "pageStartMoved")).toBe(
      false,
    );
  });

  test("a paragraph's own page start is carried, except on the document's first block", () => {
    const { plan } = build(
      withFacts(["SMLOUVA", "Text.", "Příloha č. 1", "Seznam."], {
        0: { pageBreakBefore: true },
        2: { pageBreakBefore: true },
      }),
    );
    expect(starts(plan)).toEqual(["p2"]);
  });

  test("a page the source cut short is measured from the source's own start, also when the start moved in front of a heading", () => {
    // The start in front of 2.1 moves in front of the heading of its
    // article. The page that follows is short by its own text; the heading
    // the start moved to is no part of it.
    const { plan } = build(
      withFacts(
        [
          "SMLOUVA",
          "Článek I.\nPrvní",
          `1.1\t${"Strany se dohodly na dalších podmínkách. ".repeat(40)}`,
          `Článek II.\n${"Druhý článek s velmi dlouhým názvem ".repeat(4)}`,
          `2.1\t${"Krátká strana. ".repeat(72)}`,
          "2.2\tOdstavec za stranou, kterou zdroj ukončil dříve.",
        ],
        { 4: { pageBreakBefore: true }, 5: { pageBreakBefore: true } },
      ),
    );
    expect(starts(plan)).toContain("p5");
  });

  test("a page starts only where a part of the document begins", () => {
    // A page of text, so that the break behind it is the source's
    // pagination and no page cut short on purpose.
    const page = (opening: string): string =>
      `${opening} ${"Strany se dohodly na dalších podmínkách. ".repeat(40)}`;
    const { plan, note } = build(
      withFacts(
        [
          "SMLOUVA",
          "Strana první, se sídlem v Praze",
          "Článek I.\nPrvní",
          page("1.1\tOdstavec prvního článku."),
          "1.2\tDruhý odstavec prvního článku.",
          "Článek II.\nDruhý",
          page("2.1\tOdstavec druhého článku."),
          "Příloha č. 1",
          page("Seznam."),
          "Další položky seznamu.",
          "Podpisová strana",
          "Dodatek k seznamu.",
        ],
        {
          2: { pageBreakBefore: true },
          4: { pageBreakBefore: true },
          5: { pageBreakBefore: true },
          7: { pageBreakBefore: true },
          9: { pageBreakBefore: true },
          10: { pageBreakBefore: true },
          11: { pageBreakBefore: true },
        },
      ),
    );
    // In front of an article and of an annex, and behind a page cut
    // short; not in the middle of an article, nor in the middle of an
    // annex. Between the title page and the first article the template
    // decides: its own sample runs on, so the document does.
    expect(starts(plan)).toEqual(["p5", "p7", "p10", "p11"]);
    expect(
      note.items.filter(({ kind }) => kind === "pageStartDropped"),
    ).toEqual([
      { kind: "pageStartDropped", blockId: "p2", reason: "templateFlowsOn" },
      { kind: "pageStartDropped", blockId: "p4", reason: "opensNoPart" },
      { kind: "pageStartDropped", blockId: "p9", reason: "opensNoPart" },
    ]);
    // A template whose sample starts a page there keeps the document's.
    const paged = build(
      withFacts(["SMLOUVA", "Strana první", "Článek I.\nPrvní", "Text."], {
        2: { pageBreakBefore: true },
      }),
      "keepSource",
      { profile: { ...PROFILE, frontMatterEndsPage: true } },
    );
    expect(starts(paged.plan)).toEqual(["p2"]);
  });

  test("short lines in front of the first article and the text of cells keep the alignment the source sets them in", () => {
    const table = inColumns(2, ["Položka", "Cena", "První", "100"]);
    const [cells, ...inner] = table.blocks;
    const front = withFacts(
      [
        "SMLOUVA",
        "(dále jen „Smlouva“)",
        "mezi:",
        "- dále jen „Strana 1“ -",
        "Článek I.\nPrvní",
        "Text ustanovení.",
        "Zarovnáno vpravo za článkem.",
      ],
      {
        0: { alignment: "center" },
        1: { alignment: "center" },
        3: { alignment: "right" },
        6: { alignment: "right" },
      },
    );
    if (cells === undefined) {
      throw new Error("fixture");
    }
    const amount = inner.at(3);
    if (amount !== undefined) {
      amount.alignment = "right";
    }
    const shifted = [cells, ...inner].map((block) => ({
      ...block,
      id: `c${block.id}`,
      index: block.index + 100,
      ...(block.cells === undefined
        ? {}
        : {
            cells: block.cells.map((cell) => ({
              ...cell,
              blockIds: cell.blockIds.map((id) => `c${id}`),
            })),
          }),
    }));
    const { plan, note } = build({
      ...front,
      blocks: [...front.blocks, ...shifted],
    });
    const aligned = sourceItems(plan).flatMap((item) => [
      ...(item.alignment === undefined ? [] : [[item.blockId, item.alignment]]),
      ...(item.nested ?? []).flatMap((nested) =>
        nested.alignment === undefined
          ? []
          : [[nested.blockId, nested.alignment]],
      ),
    ]);
    // The title is centred by its style; a line behind the first article
    // takes its style's alignment.
    expect(aligned).toEqual([
      ["p1", "center"],
      ["p3", "right"],
      ["cp3", "right"],
    ]);
    expect(itemOf(plan, front, "(dále jen")).not.toMatchObject({
      styleId: "Title",
    });
    expect(note.items).toContainEqual({ kind: "alignmentsKept", blocks: 3 });
  });

  test("the text of a table takes the style the template writes its tables in", () => {
    const table = inColumns(2, ["Položka", "Cena", "1. První", "100"]);
    const plain = build(table);
    const styled = build(table, "keepSource", {
      profile: { ...PROFILE, tableText: { styleId: "TableText" } },
    });
    const nestedOf = ({ plan }: typeof plain) =>
      sourceItems(plan).find(({ blockId }) => blockId === "t0")?.nested ?? [];
    // Without such a style a cell paragraph is placed as its table has it.
    expect(nestedOf(plain).every(({ styleId }) => styleId === undefined)).toBe(
      true,
    );
    expect(
      nestedOf(styled).map(({ blockId, styleId }) => [blockId, styleId]),
    ).toEqual([
      ["p0", "TableText"],
      ["p1", "TableText"],
      ["p2", "TableText"],
      ["p3", "TableText"],
    ]);
  });

  test("in front of a table the blank paragraph stays with its break", () => {
    const cells = inColumns(1, ["položka"]).blocks.map((block) => ({
      ...block,
      id: `c${block.id}`,
      ...(block.cells === undefined
        ? {}
        : {
            cells: block.cells.map((cell) => ({
              ...cell,
              blockIds: cell.blockIds.map((id) => `c${id}`),
            })),
          }),
    }));
    const paragraphs = withFacts(["SMLOUVA", "Text.", "", "Závěr."], {
      2: { pageBreaks: 1 },
      3: { pageBreakBefore: true },
    });
    const [title, text, blank, last] = paragraphs.blocks;
    if (
      title === undefined ||
      text === undefined ||
      blank === undefined ||
      last === undefined
    ) {
      throw new Error("fixture");
    }
    const tableId = cells.at(0)?.id ?? "";
    const { plan, note } = build({
      ...paragraphs,
      blocks: [title, text, blank, ...cells, last],
    });
    expect(plan.omit).toEqual([]);
    expect(sourceItems(plan).map(({ blockId }) => blockId)).toEqual([
      "p0",
      "p1",
      "p2",
      tableId,
      "p3",
    ]);
    expect(starts(plan)).toEqual(["p3"]);
    expect(notes(note, "pageStartNotKept")).toEqual([]);

    // A section that begins on a new page with a table: the blank
    // paragraph that closes the section before stays and starts the page.
    const sections = [section(0, "nextPage"), section(1, "nextPage")];
    const closing = withFacts(["SMLOUVA", "Text.", ""], {
      2: { endsSection: true },
    }).blocks.at(2);
    const sectioned = build({
      ...paragraphs,
      blocks: [
        title,
        text,
        ...(closing === undefined ? [] : [closing]),
        ...cells,
      ],
      sections,
    });
    expect(sectioned.plan.omit).toEqual([]);
    expect(starts(sectioned.plan)).toEqual(["p2"]);
    expect(notes(sectioned.note, "pageStartNotKept")).toEqual([]);

    // The break stands behind the blank paragraph, in a line of the
    // source's contents that is left out: the blank paragraph still starts
    // the page, and nothing is reported as lost.
    const contents = withFacts(
      ["SMLOUVA", "Text.", "", "Článek I. Předmět\t2"],
      { 3: { pageBreakBefore: true, styleName: "toc 1" } },
    );
    const later = build({
      ...contents,
      blocks: [...contents.blocks, ...cells],
    });
    expect(starts(later.plan)).toEqual(["p2"]);
    expect(later.plan.omit).toEqual([{ blockId: "p3", reason: "sourceToc" }]);
    expect(notes(later.note, "pageStartNotKept")).toEqual([]);

    // Without a blank paragraph in front of the table nothing can start
    // the page, and the note says so.
    const bare = build({
      ...paragraphs,
      blocks: [title, { ...text, endsSection: true }, ...cells],
      sections,
    });
    expect(starts(bare.plan)).toEqual([]);
    expect(notes(bare.note, "pageStartNotKept")).toEqual([
      { kind: "pageStartNotKept", blockId: tableId, reason: "table" },
    ]);
  });

  const sectioned = (facts: Readonly<Record<number, Partial<DocxBlock>>>) =>
    withFacts(
      ["SMLOUVA", "Text.", "Příloha č. 1", "Tabulka.", "Dodatek.", "Konec."],
      {
        1: { endsSection: true },
        2: { sectionIndex: 1 },
        3: { sectionIndex: 1, endsSection: true },
        4: { sectionIndex: 2, endsSection: true },
        5: { sectionIndex: 3 },
        ...facts,
      },
      [
        section(0, "nextPage"),
        section(1, "nextPage", "landscape"),
        section(2, "oddPage"),
        section(3, "continuous"),
      ],
    );
  const ends = (plan: TemplatePlan) =>
    sourceItems(plan).flatMap(({ blockId, endsSection }) =>
      endsSection === undefined ? [] : [[blockId, endsSection] as const],
    );

  test("a section whose page is another stays a section, and so do the ends around it", () => {
    const { plan, note } = build(sectioned({}));
    // Portrait up to p1, landscape up to p3, then the rest: it begins on
    // an odd page as the section after the annex did.
    expect(ends(plan)).toEqual([
      ["p1", {}],
      [
        "p3",
        {
          page: {
            orientation: "landscape",
            width: 16_838,
            height: 11_906,
            margins: { top: 1417, right: 1417, bottom: 1417, left: 1417 },
          },
        },
      ],
    ]);
    expect(plan.lastSection).toEqual({ start: "oddPage" });
    // The sections start their own pages; nothing else has to.
    expect(starts(plan)).toEqual([]);
    expect(note.counts.sectionsKept).toBe(3);
    expect(notes(note, "sectionLayoutNotKept")).toEqual([
      {
        kind: "sectionLayoutNotKept",
        afterBlockId: "p4",
        start: "continuous",
        pageDiffers: false,
        columns: 1,
      },
    ]);
  });

  test("a blank paragraph that ends such a section stays to carry it", () => {
    const blank = withFacts(
      ["SMLOUVA", "Text.", "", "Příloha č. 1"],
      { 2: { endsSection: true }, 3: { sectionIndex: 1 } },
      [section(0, "nextPage"), section(1, "nextPage", "landscape")],
    );
    const { plan } = build(blank);
    expect(plan.omit).toEqual([]);
    expect(ends(plan)).toEqual([["p2", {}]]);
    expect(plan.lastSection?.page?.orientation).toBe("landscape");
    expect(starts(plan)).toEqual([]);
  });

  test("a title behind the end of a kept section is not joined to the heading that ends it", () => {
    const reading = (
      blockId: string,
      role: "title" | "articleHeading" | "body",
      mergedIntoBlockId: string | null = null,
    ) => ({
      blockId,
      role,
      confidence: 0.9,
      alternatives: [],
      mergedIntoBlockId,
    });
    // The landscape section is declared continuous: only its page says
    // that it starts a new one.
    const manifest = withFacts(
      ["SMLOUVA", "Článek I.", "Předmět smlouvy", "Text."],
      {
        1: { endsSection: true },
        2: { sectionIndex: 1 },
        3: { sectionIndex: 1 },
      },
      [section(0, "nextPage"), section(1, "continuous", "landscape")],
    );
    const { plan } = build(manifest, "keepSource", {
      roles: [
        reading("p0", "title"),
        reading("p1", "articleHeading"),
        reading("p2", "articleHeading", "p1"),
        reading("p3", "body"),
      ],
    });
    const heading = itemOf(plan, manifest, "Článek I.");
    expect(heading?.mergeNext).toBeUndefined();
    expect(heading?.endsSection).toEqual({});
    expect(plan.lastSection?.page?.orientation).toBe("landscape");
  });

  test("where a section's end cannot be carried, the pages still start and the note says what is lost", () => {
    // The annex ends in a line of the source's own contents.
    const { plan, note } = build(
      sectioned({
        3: {
          sectionIndex: 1,
          endsSection: true,
          text: "Článek I. Předmět\t2",
          styleName: "toc 1",
        },
      }),
    );
    expect(ends(plan)).toEqual([]);
    expect(plan.lastSection).toBeUndefined();
    expect(starts(plan)).toEqual(["p2", "p4"]);
    expect(note.counts.sectionsKept).toBe(0);
    expect(
      notes(note, "sectionLayoutNotKept").map((item) =>
        item.kind === "sectionLayoutNotKept" ? item.pageDiffers : null,
      ),
    ).toEqual([true, false]);
  });

  test("a title that starts a page takes an article's heading with it, and is no part of another heading", () => {
    const reading = (
      blockId: string,
      role: "title" | "articleHeading" | "annexHeading" | "clause1" | "body",
      mergedIntoBlockId: string | null = null,
    ) => ({
      blockId,
      role,
      confidence: 0.9,
      alternatives: [],
      mergedIntoBlockId,
    });
    const roles = [
      reading("p0", "title"),
      reading("p1", "articleHeading"),
      reading("p2", "articleHeading", "p1"),
      reading("p3", "clause1"),
    ];
    const texts = ["SMLOUVA", "Článek I.", "Předmět smlouvy", "Odstavec."];
    const joined = build(manifestOf(texts), "keepSource", { roles });
    expect(itemOf(joined.plan, manifestOf(texts), "Článek I.")?.mergeNext).toBe(
      "none",
    );
    for (const [facts, annexFacts] of [
      // By its own formatting, and by the section that ends in front of it.
      [{ 2: { pageBreakBefore: true } }, { 3: { pageBreakBefore: true } }],
      [
        { 1: { endsSection: true }, 2: { sectionIndex: 1 } },
        { 2: { endsSection: true }, 3: { sectionIndex: 1 } },
      ],
    ] as const) {
      const manifest = withFacts(texts, facts, [
        section(0, "nextPage"),
        section(1, "nextPage"),
      ]);
      // The article's heading and its title start the page together, on
      // a template whose own first article starts a page.
      const { plan, note } = build(manifest, "keepSource", {
        roles,
        profile: { ...PROFILE, frontMatterEndsPage: true },
      });
      expect(itemOf(plan, manifest, "Článek I.")?.mergeNext).toBe("none");
      expect(starts(plan)).toEqual(["p1"]);
      expect(
        note.items.filter(({ kind }) => kind === "pageStartMoved"),
      ).toEqual([{ kind: "pageStartMoved", blockId: "p1", fromBlockId: "p2" }]);

      // An annex may be headed on a page of its own: its title stays a
      // line of the page it starts.
      const annexTexts = ["SMLOUVA", "Text.", "Příloha č. 1", "Ceník", "Ceny."];
      const annex = withFacts(annexTexts, annexFacts, [
        section(0, "nextPage"),
        section(1, "nextPage"),
      ]);
      const kept = build(annex, "keepSource", {
        roles: [
          reading("p0", "title"),
          reading("p1", "body"),
          reading("p2", "annexHeading"),
          reading("p3", "annexHeading", "p2"),
          reading("p4", "body"),
        ],
      });
      expect(
        itemOf(kept.plan, annex, "Příloha č. 1")?.mergeNext,
      ).toBeUndefined();
      expect(starts(kept.plan)).toEqual(["p3"]);
    }

    // In front of a table, which cannot be told to start a page, the
    // heading still starts it.
    const cells = inColumns(1, ["položka"]).blocks.map((block) => ({
      ...block,
      id: `c${block.id}`,
      ...(block.cells === undefined
        ? {}
        : {
            cells: block.cells.map((cell) => ({
              ...cell,
              blockIds: cell.blockIds.map((id) => `c${id}`),
            })),
          }),
    }));
    const headed = withFacts(texts.slice(0, 3), {
      2: { pageBreakBefore: true },
    });
    const beforeTable = build(
      { ...headed, blocks: [...headed.blocks, ...cells] },
      "keepSource",
      {
        roles: roles.slice(0, 3),
        profile: { ...PROFILE, frontMatterEndsPage: true },
      },
    );
    expect(starts(beforeTable.plan)).toEqual(["p1"]);
    expect(notes(beforeTable.note, "pageStartNotKept")).toEqual([]);
  });

  test("between two tables one blank paragraph stays, and the page starts once", () => {
    const table = (id: string) =>
      inColumns(1, ["položka"]).blocks.map((block) => ({
        ...block,
        id: `${id}${block.id}`,
        hash: `h${id}`,
        ...(block.cells === undefined
          ? {}
          : {
              cells: block.cells.map((cell) => ({
                ...cell,
                blockIds: cell.blockIds.map((blockId) => `${id}${blockId}`),
              })),
            }),
      }));
    for (const [breakAt, expected] of [
      // The break in the first blank paragraph: the second stays and is
      // told to start the page.
      [1, { kept: "p2", starts: ["p2"] }],
      // The break in the second: it stays with its break.
      [2, { kept: "p2", starts: [] }],
    ] as const) {
      const paragraphs = withFacts(["SMLOUVA", "", ""], {
        [breakAt]: { pageBreaks: 1 },
      });
      const [title, first, second] = paragraphs.blocks;
      if (title === undefined || first === undefined || second === undefined) {
        throw new Error("fixture");
      }
      const { plan } = build({
        ...paragraphs,
        blocks: [title, ...table("a"), first, second, ...table("b")],
      });
      expect(
        sourceItems(plan)
          .map(({ blockId }) => blockId)
          .filter((id) => id === "p1" || id === "p2"),
      ).toEqual([expected.kept]);
      expect(starts(plan)).toEqual([...expected.starts]);
    }
  });

  test("a manifest without break facts starts no page", () => {
    const { plan, note } = build(czechContract("Text."));
    expect(starts(plan)).toEqual([]);
    expect(note.counts.pageStarts).toBe(0);
  });
});

describe("buildTemplatePlan, justified lines in front of a manual line break", () => {
  const body = PROFILE.roles.body;
  /** The template with its body style justified. */
  const justified = {
    profile: {
      ...PROFILE,
      roles: {
        ...PROFILE.roles,
        body: body === null ? null : { ...body, alignment: "both" },
      },
    },
  };
  const texts = ["SMLOUVA", "První řádek\ndruhý řádek.", "Jeden řádek."];
  const withCompat = (
    doNotExpandShiftReturn: boolean,
    alignment?: string,
  ): DocxBlockManifest => {
    const manifest = manifestOf(texts);
    return {
      ...manifest,
      blocks: manifest.blocks.map((block) => ({
        ...block,
        ...(alignment === undefined ? {} : { alignment }),
      })),
      compat: { doNotExpandShiftReturn },
    };
  };
  const kept = (note: ReturnType<typeof build>["note"]) =>
    note.items.filter(({ kind }) => kind === "lineBreakSpacingKept");

  test("a line break that meets justified text only in the output keeps its spacing", () => {
    const { plan, note } = build(withCompat(false), "keepSource", justified);
    expect(plan.compat).toEqual({ doNotExpandShiftReturn: true });
    expect(kept(note)).toEqual([
      {
        kind: "lineBreakSpacingKept",
        reason: "justifiedHere",
        blocks: 1,
        alreadyStretched: 0,
      },
    ]);
  });

  test("text that was justified before, and a template that does not justify, change nothing", () => {
    const before = build(withCompat(false, "both"), "keepSource", justified);
    expect(before.plan.compat).toBeUndefined();
    expect(kept(before.note)).toEqual([]);
    expect(build(withCompat(false)).plan.compat).toBeUndefined();
  });

  test("a source whose own settings kept the spacing keeps it", () => {
    const { plan, note } = build(withCompat(true, "both"));
    expect(plan.compat).toEqual({ doNotExpandShiftReturn: true });
    expect(kept(note)).toEqual([
      {
        kind: "lineBreakSpacingKept",
        reason: "source",
        blocks: 0,
        alreadyStretched: 0,
      },
    ]);
  });

  test("the setting is the document's: a paragraph that was stretched before is counted", () => {
    const manifest = withCompat(false);
    const mixed = {
      ...manifest,
      blocks: [
        ...manifest.blocks,
        ...manifestOf(["Byl\nzarovnán."]).blocks.map((block) => ({
          ...block,
          id: "p9",
          alignment: "both",
        })),
      ],
    };
    const { plan, note } = build(mixed, "keepSource", justified);
    expect(plan.compat).toEqual({ doNotExpandShiftReturn: true });
    expect(kept(note)).toEqual([
      {
        kind: "lineBreakSpacingKept",
        reason: "justifiedHere",
        blocks: 1,
        alreadyStretched: 1,
      },
    ]);
  });

  test("a title joined to its heading is read in the heading's style", () => {
    const reading = (
      blockId: string,
      role: "title" | "articleHeading" | "body",
      mergedIntoBlockId: string | null = null,
    ) => ({
      blockId,
      role,
      confidence: 0.9,
      alternatives: [],
      mergedIntoBlockId,
    });
    const article = PROFILE.roles.articleHeading;
    const headings = {
      profile: {
        ...PROFILE,
        roles: {
          ...PROFILE.roles,
          articleHeading:
            article === null ? null : { ...article, alignment: "both" },
        },
      },
    };
    const manifest = {
      ...manifestOf(["SMLOUVA", "Článek I.", "Předmět\nsmlouvy", "Text."]),
      compat: { doNotExpandShiftReturn: false },
    };
    const { plan, note } = build(manifest, "keepSource", {
      ...headings,
      roles: [
        reading("p0", "title"),
        reading("p1", "articleHeading"),
        reading("p2", "articleHeading", "p1"),
        reading("p3", "body"),
      ],
    });
    expect(itemOf(plan, manifest, "Článek I.")?.mergeNext).toBeDefined();
    expect(plan.compat).toEqual({ doNotExpandShiftReturn: true });
    expect(kept(note).at(0)).toMatchObject({ blocks: 1 });
  });

  test("a manifest without the facts changes nothing", () => {
    const { plan } = build(manifestOf(texts), "keepSource", justified);
    expect(plan.compat).toBeUndefined();
  });
});

describe("buildTemplatePlan, citations of a level that prints punctuated words", () => {
  // Articles `Čl. 1` to `Čl. 6`: a number-only field would show `.2`.
  const fieldsOf = (citing: string) => {
    const manifest = czechDecimalContract(citing);
    const { plan, note } = build(manifest);
    const blockId = blockIdOf(manifest, citing);
    return {
      citing,
      references: (plan.references ?? []).filter(
        (reference) => reference.blockId === blockId,
      ),
      unlinked: note.items.filter(
        (item) => item.kind === "referenceUnlinked" && item.blockId === blockId,
      ),
    };
  };

  test("one field stands for word and number, in the citation's spelling", () => {
    const { citing, references, unlinked } = fieldsOf(
      "Podle čl. 3 této smlouvy platí čl. 2.1 obdobně.",
    );
    expect(
      references.map(({ start, end, instruction, expectedText }) => ({
        cited: citing.slice(start, end),
        instruction,
        expectedText,
      })),
    ).toEqual([
      {
        cited: "čl. 3",
        instruction: String.raw`\n \* lower \h`,
        expectedText: "čl. 3",
      },
      { cited: "2.1", instruction: String.raw`\n \h`, expectedText: "2.1" },
    ]);
    expect(unlinked).toEqual([]);
  });

  test("a citation at the start of a sentence needs no letter-case format", () => {
    const { references } = fieldsOf("Čl. 3 této smlouvy se použije obdobně.");
    expect(references).toEqual([
      expect.objectContaining({
        start: 0,
        instruction: String.raw`\n \h`,
        expectedText: "Čl. 3",
      }),
    ]);
  });

  test("other words, or another blank, leave the citation as text with the reason", () => {
    expect(fieldsOf("Podle článku 3 této smlouvy.")).toMatchObject({
      references: [],
      unlinked: [expect.objectContaining({ reason: "punctuatedLevelWords" })],
    });
    expect(fieldsOf("Podle čl.\u00A03 této smlouvy.")).toMatchObject({
      references: [],
      unlinked: [expect.objectContaining({ reason: "blankDiffers" })],
    });
  });
});

describe("buildTemplatePlan, a template with text effects that show nothing", () => {
  test("the note says that the output is written without them", () => {
    const manifest = czechContract("Text.");
    const { note } = build(manifest, "keepSource", {
      profile: {
        ...PROFILE,
        health: [
          { kind: "numberDrawnAsPicture", abstractNumId: 2, ilvl: 0 },
          { kind: "numberDrawnAsPicture", abstractNumId: 2, ilvl: 1 },
          { kind: "textDrawnAsPicture", styleId: "Title" },
        ],
      },
    });
    expect(
      note.items.filter(({ kind }) => kind === "invisibleEffectsRemoved"),
    ).toEqual([{ kind: "invisibleEffectsRemoved", levels: 2, styles: 1 }]);
    expect(
      build(manifest).note.items.some(
        ({ kind }) => kind === "invisibleEffectsRemoved",
      ),
    ).toBe(false);
  });
});

describe("buildTemplatePlan, a level the template sets apart from its siblings", () => {
  const manifest = manifestOf([
    "SMLOUVA",
    "Článek I. Předmět",
    numbered("1.1.", "První ujednání."),
    numbered("1.1.1.", "Podrobnost prvního ujednání."),
    numbered("1.1.1.1.", "Podrobnost podrobnosti."),
  ]);
  const apart = {
    ...PROFILE,
    health: [
      {
        kind: "levelSetApart",
        role: "clause2",
        styleId: "Clause2",
        bold: true,
        size: 24,
        insteadStyleId: "Clause1",
      },
    ],
  } satisfies typeof PROFILE;
  const placedAs = (profile: typeof PROFILE, start: string) => {
    const item = itemOf(
      build(manifest, "houseScheme", { profile }).plan,
      manifest,
      start,
    );
    return { styleId: item?.styleId, ilvl: item?.numbering?.ilvl };
  };

  test("its paragraphs take the sibling's style on their own level, and the note says so", () => {
    // The template's own placement, for comparison.
    expect(placedAs(PROFILE, "Podrobnost prvního")).toEqual({
      styleId: "Clause2",
      ilvl: 2,
    });
    expect(placedAs(apart, "Podrobnost prvního")).toEqual({
      styleId: "Clause1",
      ilvl: 2,
    });
    // A deeper level that borrows the style borrows the sibling's too.
    expect(placedAs(apart, "Podrobnost podrobnosti").styleId).toBe("Clause1");
    expect(placedAs(apart, "První ujednání")).toEqual({
      styleId: "Clause1",
      ilvl: 1,
    });
    expect(
      build(manifest, "keepSource", { profile: apart }).note.items.filter(
        ({ kind }) => kind === "levelStyleEvened",
      ),
    ).toEqual([
      {
        kind: "levelStyleEvened",
        role: "clause2",
        styleId: "Clause2",
        insteadStyleId: "Clause1",
        blocks: 1,
      },
    ]);
  });

  test("a profile that keeps the template's looks keeps the style", () => {
    const kept = {
      ...apart,
      levelLooks: "asTemplate",
    } satisfies typeof PROFILE;
    expect(placedAs(kept, "Podrobnost prvního").styleId).toBe("Clause2");
    expect(
      build(manifest, "keepSource", { profile: kept }).note.items.some(
        ({ kind }) => kind === "levelStyleEvened",
      ),
    ).toBe(false);
  });
});

describe("buildTemplatePlan, running text numbered like articles", () => {
  const running = (label: string, name: string) =>
    `${label}\t${name}. Strana, která informace přijímá, je nesmí bez souhlasu druhé strany nikomu zpřístupnit ani použít k jinému účelu.`;
  const manifest = manifestOf([
    "DOHODA O MLČENLIVOSTI",
    running("1.", "Důvěrné informace"),
    running("2.", "Výjimky"),
    running("3.", "Trvání"),
    "4.\tZávěrečná ustanovení",
    "4.1\tDohoda se řídí českým právem.",
  ]);

  test("they keep the article's level and are set as clauses", () => {
    const { plan, note } = build(manifest, "houseScheme");
    const first = itemOf(plan, manifest, "1.");
    expect(first).toMatchObject({
      styleId: "Clause1",
      numbering: { ilvl: PROFILE.roles.articleHeading?.numbering?.ilvl },
    });
    // The heading among them stays a heading.
    expect(itemOf(plan, manifest, "4.\tZávěrečná")?.styleId).toBe("Article");
    expect(
      note.items.filter(({ kind }) => kind === "articlesSetAsText"),
    ).toEqual([{ kind: "articlesSetAsText", blocks: 3 }]);
  });

  test("a document with headings keeps them", () => {
    const headed = czechContract("Text.");
    const { plan, note } = build(headed);
    expect(itemOf(plan, headed, "Článek II.")?.styleId).toBe("Article");
    expect(note.items.some(({ kind }) => kind === "articlesSetAsText")).toBe(
      false,
    );
  });
});

describe("buildTemplatePlan, what is left unlinked", () => {
  const manifest = czechContract(
    "Viz čl. XX této smlouvy a čl. II odst. 2 této smlouvy.",
  );

  test("an internal reference without a target is highlighted in a colour the source does not use", () => {
    const { plan, note } = build(manifest, "keepSource", {
      sourceHighlightColors: ["cyan", "yellow"],
    });
    const citing = blockIdOf(manifest, "Viz čl. XX");
    expect(plan.highlights).toEqual([
      { blockId: citing, start: 8, end: 10, color: "magenta" },
    ]);
    expect(note.items).toContainEqual({
      kind: "referenceUnlinked",
      blockId: citing,
      start: 8,
      end: 10,
      reason: "unresolved",
      highlighted: true,
    });
    expect(build(manifest).plan.highlights?.at(0)?.color).toBe("cyan");
  });

  test("is reported but not highlighted where the document's numbering could not be read", () => {
    // Labels in a format the label index does not know.
    const unread = manifestOf([
      "SMLOUVA",
      numbered("1st", "První ujednání."),
      numbered("2nd", "Druhé ujednání, viz čl. 7 této smlouvy."),
      numbered("3rd", "Třetí ujednání."),
    ]);
    const { plan, note } = build(unread);
    expect(plan.highlights).toBeUndefined();
    expect(note.items).toContainEqual(
      expect.objectContaining({
        kind: "referenceUnlinked",
        reason: "unresolved",
        highlighted: false,
      }),
    );
  });

  test("what an earlier attempt showed the engine refuses is left out", () => {
    const citing = blockIdOf(manifest, "Viz čl. XX");
    const article = blockIdOf(manifest, "Článek II.");
    const { plan, note } = build(manifest, "keepSource", {
      exclusions: {
        ...NO_EXCLUSIONS,
        marks: new Set([citing]),
        numbering: new Set([article]),
        merges: new Set([blockIdOf(manifest, "Článek I.")]),
      },
    });
    expect(
      (plan.references ?? []).some(({ blockId }) => blockId === citing),
    ).toBe(false);
    expect(plan.highlights ?? []).toEqual([]);
    expect(itemOf(plan, manifest, "Článek II.")).toMatchObject({
      numbering: null,
    });
    expect(itemOf(plan, manifest, "Článek I.")).not.toHaveProperty("mergeNext");
    // The title that could not join is a heading line without a number.
    expect(itemOf(plan, manifest, "Úvodní ustanovení")).toMatchObject({
      styleId: "Article",
      numbering: null,
    });
    expect(note.items).toContainEqual({
      kind: "labelKeptAsText",
      blockId: article,
      reason: "excluded",
    });
  });
});

describe("buildTemplatePlan, split headings", () => {
  test("a heading takes one title; a second one is a heading line of its own", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I.",
      "Předmět smlouvy",
      "a účel plnění",
      numbered("1.", "Odstavec.", 1),
    ]);
    const reading = (
      blockId: string,
      role: "title" | "articleHeading" | "clause1",
      mergedIntoBlockId: string | null = null,
    ) => ({
      blockId,
      role,
      confidence: 0.9,
      alternatives: [],
      mergedIntoBlockId,
    });
    const { plan } = build(manifest, "keepSource", {
      roles: [
        reading("p0", "title"),
        reading("p1", "articleHeading"),
        reading("p2", "articleHeading", "p1"),
        reading("p3", "articleHeading", "p1"),
        reading("p4", "clause1"),
      ],
    });
    expect(
      sourceItems(plan).map(({ blockId, mergeNext, styleId }) => [
        blockId,
        mergeNext ?? null,
        styleId ?? null,
      ]),
    ).toEqual([
      ["p0", null, "Title"],
      ["p1", "none", "Article"],
      ["p2", null, null],
      ["p3", null, "Article"],
      ["p4", null, "Clause1"],
    ]);
  });
});

describe("buildTemplatePlan, the house scheme", () => {
  test("numbers by the template's levels and lets fields show the new numbers", () => {
    const manifest = czechContract("Viz čl. II odst. 2 této smlouvy.");
    const { plan, note } = build(manifest, "houseScheme");
    // The template's formats stay, and its headings stand on one line.
    expect(plan.numberingPatches).toBeUndefined();
    expect(itemOf(plan, manifest, "Článek II.")).toMatchObject({
      numbering: { numId: OUTLINE_LIST, ilvl: 0 },
      stripLabel: "Článek II.",
    });
    const citing = blockIdOf(manifest, "Viz čl. II");
    expect(
      (plan.references ?? [])
        .filter(({ blockId }) => blockId === citing)
        .map(({ expectedText, instruction }) => [expectedText, instruction]),
    ).toEqual([
      // `2.2.` without its closing period.
      ["2.2", String.raw`\n \h`],
    ]);
    // The article level prints `Art. 2`: a field would show `.2`, so the
    // reference to the article stays text. The article is renumbered, so
    // the typed `II` is marked for a person to correct.
    expect(note.items).toContainEqual(
      expect.objectContaining({
        kind: "referenceUnlinked",
        blockId: citing,
        reason: "punctuatedLevelWords",
        highlighted: true,
        targetRenumbered: true,
      }),
    );
    expect(plan.highlights).toContainEqual(
      expect.objectContaining({ blockId: citing }),
    );
    // Where the source's numbers are kept, nothing is renumbered.
    expect(
      build(manifest).note.items.filter(
        (item) => item.kind === "referenceUnlinked" && item.targetRenumbered,
      ),
    ).toEqual([]);
  });
});

describe("buildTemplatePlan, tables and omissions", () => {
  test("a table is placed whole; blank paragraphs and the source's contents are omitted", () => {
    const cells = inColumns(2, ["položka", "cena"]);
    const rest = manifestOf([
      "SMLOUVA",
      { text: "Článek I. Předmět\t2", styleName: "toc 1" },
      "",
      "Článek I.\nPředmět",
      numbered("1.", "Text.", 1),
    ]);
    const blocks = [
      ...rest.blocks.map((block) => ({ ...block, id: `r${block.id}` })),
      ...cells.blocks,
    ];
    const { plan } = build({ ...rest, blocks });
    expect(plan.omit).toEqual([
      { blockId: "rp1", reason: "sourceToc" },
      { blockId: "rp2", reason: "empty" },
    ]);
    expect(sourceItems(plan).map(({ blockId }) => blockId)).toEqual([
      "rp0",
      "rp3",
      "rp4",
      "t0",
    ]);
    expect(sourceItems(plan).at(-1)).toEqual({
      kind: "source",
      blockId: "t0",
      hash: "ht0",
    });
  });

  test("a blank paragraph stays where it parts two tables or closes the document after one", () => {
    const table = (id: string) =>
      inColumns(1, ["položka"]).blocks.map((block) => ({
        ...block,
        id: `${id}${block.id}`,
        hash: `h${id}`,
        ...(block.kind === "table"
          ? {
              cells: (block.cells ?? []).map((cell) => ({
                ...cell,
                blockIds: cell.blockIds.map((blockId) => `${id}${blockId}`),
              })),
            }
          : {}),
      }));
    const paragraphs = manifestOf(["SMLOUVA", "", "", "Text.", "", "", ""]);
    const [title, blankA, blankB, text, blankC, blankD, blankE] =
      paragraphs.blocks;
    if (
      title === undefined ||
      blankA === undefined ||
      blankB === undefined ||
      text === undefined ||
      blankC === undefined ||
      blankD === undefined ||
      blankE === undefined
    ) {
      throw new Error("fixture");
    }
    const blocks = [
      title,
      // In front of a table nothing has to stay.
      blankA,
      ...table("a"),
      // Text parts these two tables: the blank one may go.
      blankB,
      text,
      ...table("b"),
      // Only blank paragraphs part these two: the first stays.
      blankC,
      blankD,
      ...table("c"),
      // And the document may not end in a table.
      blankE,
    ];
    const { plan } = build({ ...paragraphs, blocks });
    expect(plan.omit).toEqual([
      { blockId: blankA.id, reason: "empty" },
      { blockId: blankB.id, reason: "empty" },
      { blockId: blankD.id, reason: "empty" },
    ]);
    expect(sourceItems(plan).map(({ blockId }) => blockId)).toEqual([
      title.id,
      "at0",
      text.id,
      "bt0",
      blankC.id,
      "ct0",
      blankE.id,
    ]);
  });

  test("a template's kept front blocks and empty contents field stand where the template has them", () => {
    const profile = inferTemplateProfile(
      contractTemplate({ contents: "empty" }),
    );
    const manifest = czechContract("Text.");
    const { plan, note } = build(manifest, "keepSource", { profile });
    const firstArticle = plan.body.findIndex(
      (item) =>
        item.kind === "source" &&
        item.blockId === blockIdOf(manifest, "Článek I."),
    );
    // In front of the first recital: the line before the first article.
    expect(plan.body[firstArticle - 2]).toEqual({
      kind: "template",
      templateBlockIds: ["p4", "p5", "p6", "p7"],
    });
    expect(note.items).toContainEqual({
      kind: "templateBlocksKept",
      region: "contents",
      blockIds: ["p4", "p5", "p6", "p7"],
    });
  });

  test("the template's contents stand in front of the heading that opens the preamble, not under it", () => {
    const profile = inferTemplateProfile(
      contractTemplate({ contents: "empty" }),
    );
    const manifest = manifestOf([
      "SMLOUVA O DODÁVCE",
      "Dodavatel: Horák Stavby s.r.o., se sídlem Dlouhá 1, Praha, IČO: 00000001",
      "a",
      "Objednatel: Tiskárna Vltavín a.s., se sídlem Krátká 2, Brno, IČO: 00000002",
      { text: "Preambule", styleName: "heading 1", outlineLevel: 0 },
      "Strany uzavírají tuto smlouvu s ohledem na svou dlouhodobou spolupráci.",
      "Článek I.\nPředmět",
      numbered("1.", "Dodavatel dodá zboží.", 10),
    ]);
    const { plan } = build(manifest, "keepSource", { profile });
    const preamble = plan.body.findIndex(
      (item) =>
        item.kind === "source" &&
        item.blockId === blockIdOf(manifest, "Preambule"),
    );
    expect(plan.body[preamble - 1]).toEqual({
      kind: "template",
      templateBlockIds: ["p4", "p5", "p6", "p7"],
    });
    // Once: the recital under the heading does not bring them again.
    expect(plan.body.filter(({ kind }) => kind === "template")).toHaveLength(1);
  });
});

describe("buildTemplatePlan invariants", () => {
  const documents = {
    czech: czechContract("Viz čl. II odst. 2 písm. d) a čl. XX této smlouvy."),
    decimal: czechDecimalContract("Viz čl. 3.1 této smlouvy."),
    english: englishAgreement("See Clause 2.3(a) and Annex 1."),
    german: germanContract("Siehe § 3 Abs. 1 lit. b dieses Vertrages."),
  };
  const modes = ["keepSource", "houseScheme"] as const;

  for (const [name, manifest] of Object.entries(documents)) {
    for (const mode of modes) {
      test(`${name}, ${mode}: every block is placed or omitted once, and every mark fits`, () => {
        const { plan, note } = build(manifest, mode);
        const items = sourceItems(plan);
        const placed = items.map(({ blockId }) => blockId);
        const omitted = plan.omit.map(({ blockId }) => blockId);
        expect([...placed, ...omitted].toSorted()).toEqual(
          manifest.blocks.map(({ id }) => id).toSorted(),
        );
        const byId = new Map(manifest.blocks.map((block) => [block.id, block]));
        const numberedIds = new Set(
          items.flatMap(({ blockId, numbering }) =>
            typeof numbering === "object" && numbering !== null
              ? [blockId]
              : [],
          ),
        );
        for (const [position, item] of items.entries()) {
          // A joined title carries nothing of its own.
          if (items[position - 1]?.mergeNext !== undefined) {
            expect(Object.keys(item).toSorted()).toEqual([
              "blockId",
              "hash",
              "kind",
            ]);
          }
          const text = byId.get(item.blockId)?.text ?? "";
          expect(text.trimStart().startsWith(item.stripLabel ?? "")).toBe(true);
        }
        const spans = [...(plan.references ?? []), ...(plan.highlights ?? [])];
        for (const { blockId, start, end } of spans) {
          const text = byId.get(blockId)?.text ?? "";
          expect(start).toBeLessThan(end);
          expect(end).toBeLessThanOrEqual(text.length);
          expect(placed).toContain(blockId);
        }
        for (const {
          blockId,
          targetBlockId,
          start,
          end,
          expectedText,
        } of plan.references ?? []) {
          expect(numberedIds.has(targetBlockId)).toBe(true);
          expect(targetBlockId).not.toBe(blockId);
          if (mode === "keepSource") {
            // Keeping the source's numbering never changes a word.
            expect(expectedText).toBe(
              byId.get(blockId)?.text.slice(start, end) ?? "",
            );
          }
        }
        expect(note.counts.placed).toBe(placed.length);
        expect(note.counts.numbered).toBe(numberedIds.size);
      });
    }
  }
});

describe("buildTemplatePlan, what a paragraph states for itself", () => {
  test("a provision that is only a title stays with the provisions under it", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I.\nPrvní",
      "1.\tPlán plnění",
      "1.1\tZhotovitel předloží plán do deseti dnů.",
      "1.2\tObjednatel se k plánu vyjádří.",
      "2.\tZhotovitel odpovídá za škodu, kterou způsobí porušením svých povinností podle této smlouvy, v plném rozsahu.",
      "2.1\tOdpovědnost se neomezuje.",
    ]);
    const { plan, note } = build(manifest);
    const kept = sourceItems(plan)
      .filter(({ keepNext }) => keepNext === true)
      .map(({ blockId }) => blockId);
    // Not the heading, whose style keeps it; not a sentence of its own.
    expect(kept).toEqual([blockIdOf(manifest, "1.\tPlán")]);
    expect(note.items).toContainEqual({ kind: "linesKeptWithNext", blocks: 1 });
  });

  test("a letter's closing stays together with the end of its text", () => {
    const letter = [
      "Reply to your enquiry",
      "Dear Sir or Madam,",
      "We refer to your letter and confirm that the works were handed over on time and without defects.",
      "Please do not hesitate to contact us with any further question.",
      "Yours faithfully,",
      "Jane Example",
      "Head of Contracts",
    ];
    const manifest = manifestOf(letter);
    const { plan, note } = build(manifest);
    const kept = sourceItems(plan)
      .filter(({ keepNext }) => keepNext === true)
      .map(({ blockId }) => blockId);
    // The end of the text, the closing line and the name; the last line has
    // nothing to stay with.
    expect(kept).toEqual([
      blockIdOf(manifest, "Please do not"),
      blockIdOf(manifest, "Yours faithfully"),
      blockIdOf(manifest, "Jane Example"),
    ]);
    expect(note.items).toContainEqual({
      kind: "closingKeptTogether",
      blocks: 3,
    });
    // A table in front of the closing parts it from the text before: that
    // paragraph is not kept with the table.
    const fees = inColumns(2, ["Item", "Fee"]);
    const tabled = {
      ...manifest,
      blocks: [
        ...manifest.blocks.slice(0, 4),
        ...fees.blocks.map((block) => ({ ...block, id: `fee-${block.id}` })),
        ...manifest.blocks.slice(4),
      ].map((block) =>
        block.cells === undefined
          ? block
          : {
              ...block,
              cells: block.cells.map((cell) => ({
                ...cell,
                blockIds: cell.blockIds.map((id) => `fee-${id}`),
              })),
            },
      ),
    };
    expect(
      sourceItems(build(tabled).plan)
        .filter(({ keepNext }) => keepNext === true)
        .map(({ blockId }) => blockId),
    ).toEqual([
      blockIdOf(manifest, "Yours faithfully"),
      blockIdOf(manifest, "Jane Example"),
    ]);
    // A closing line with text of the letter under it closes nothing.
    const quoted = manifestOf([
      ...letter.slice(0, 5),
      "That is how your letter of last week ended, and the next three paragraphs answer it point by point.",
      "Jane Example",
    ]);
    expect(
      sourceItems(build(quoted).plan).filter(
        ({ keepNext }) => keepNext === true,
      ),
    ).toEqual([]);
  });

  test("a long heading without a number stays with what it heads, whatever its first letter", () => {
    const long =
      "podmínky, za kterých se smluvní strany dohodly na dalším postupu při plnění celého díla";
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I.\nPrvní",
      "1.1\tZhotovitel provede dílo.",
      { text: long, styleName: "heading 1", outlineLevel: 0 },
      "Strany postupují podle harmonogramu.",
    ]);
    expect(long.length).toBeGreaterThan(80);
    const { plan } = build(manifest);
    expect(itemOf(plan, manifest, "podmínky, za kterých")).toMatchObject({
      keepNext: true,
    });
  });

  test("a heading of the source placed as text stays with what it heads", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I.\nPrvní",
      "1.1\tPrvní odstavec článku.",
      { text: "Zvláštní ujednání", styleName: "heading 3", outlineLevel: 2 },
      "Strany se dohodly na dalších podmínkách plnění.",
    ]);
    const { plan } = build(manifest);
    expect(itemOf(plan, manifest, "Zvláštní")).toMatchObject({
      keepNext: true,
    });
    expect(itemOf(plan, manifest, "1.1\t")).not.toHaveProperty("keepNext");
  });

  test("a number that stays text hangs like the numbers of its level", () => {
    // Dotted paragraphs under roman articles: the level would print II.1.
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I.\nPrvní",
      "1.1\tOdstavec prvního článku.",
      "Pokračování odstavce bez čísla.",
    ]);
    const { plan, note } = build(manifest);
    const level = PROFILE.roles.clause1?.numbering?.indent;
    expect(level?.hanging ?? 0).toBeGreaterThan(0);
    expect(itemOf(plan, manifest, "1.1\t")).toMatchObject({
      numbering: null,
      indent: { left: level?.left, hanging: level?.hanging },
    });
    // Text without a number has nothing to hang.
    expect(itemOf(plan, manifest, "Pokračování")).not.toHaveProperty("indent");
    expect(itemOf(plan, manifest, "Článek I.")).not.toHaveProperty("indent");
    expect(note.items).toContainEqual({ kind: "textLabelsHung", blocks: 1 });
  });

  test("a bullet that is a letter of a text face takes the face with it", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I.\nPrvní",
      numbered("1.", "Odstavec s výčtem:", 1),
      numbered("o", "první bod výčtu", 5),
      numbered("•", "bod jiného výčtu", 6),
    ]);
    const circle = manifest.blocks.at(3);
    const dot = manifest.blocks.at(4);
    if (circle?.numbering) {
      circle.numbering = {
        ...circle.numbering,
        bullet: true,
        bulletFont: "Courier New",
      };
    }
    if (dot?.numbering) {
      dot.numbering = { ...dot.numbering, bullet: true };
    }
    const { plan } = build(manifest);
    const patches = (plan.numberingPatches ?? []).filter(
      ({ numFmt }) => numFmt === "bullet",
    );
    expect(patches.map(({ lvlText, font }) => [lvlText, font])).toEqual([
      ["o", "Courier New"],
      ["•", undefined],
    ]);
  });
});

describe("buildTemplatePlan, a template in another language than the document", () => {
  // The fixture's template prints its articles the English way.
  const manifest = manifestOf([
    "SMLOUVA",
    "Článek I.\nPrvní",
    numbered("1.", "První odstavec článku.", 1),
    "Článek II.\nDruhý",
    numbered("1.", "První odstavec druhého článku.", 2),
  ]);
  const languages = { document: "cs", template: ["en"] };

  test("the house scheme prints the article word in the document's language", () => {
    const own = PROFILE.roles.articleHeading?.numbering;
    expect(own?.lvlText).toBe("Art. %1");
    const { plan, note } = build(manifest, "houseScheme", { languages });
    expect(plan.numberingPatches).toContainEqual(
      expect.objectContaining({
        abstractNumId: own?.abstractNumId,
        ilvl: own?.ilvl,
        lvlText: "Čl. %1",
      }),
    );
    expect(note.items).toContainEqual({
      kind: "templateLanguageDiffers",
      document: "cs",
      template: ["en"],
      labelLevels: 1,
    });
    // German puts a full stop after the number, as the firm's templates do.
    const german = build(manifest, "houseScheme", {
      languages: { document: "de", template: ["en"] },
    });
    expect(german.plan.numberingPatches).toContainEqual(
      expect.objectContaining({ lvlText: "Art. %1." }),
    );
  });

  test("a document that keeps its numbers keeps its words, and the note names the languages", () => {
    const { plan, note } = build(manifest, "keepSource", { languages });
    expect(
      (plan.numberingPatches ?? []).some(({ lvlText }) =>
        lvlText?.startsWith("Čl."),
      ),
    ).toBe(false);
    expect(note.items).toContainEqual({
      kind: "templateLanguageDiffers",
      document: "cs",
      template: ["en"],
      labelLevels: 0,
    });
  });

  test("a template in the document's language changes nothing", () => {
    const same = { document: "en", template: ["en"] };
    const { plan, note } = build(manifest, "houseScheme", { languages: same });
    expect(build(manifest, "houseScheme").plan).toEqual(plan);
    expect(note.items.map(({ kind }) => kind)).not.toContain(
      "templateLanguageDiffers",
    );
  });
});

describe("buildTemplatePlan, the lines of the parties", () => {
  const manifest = manifestOf([
    "SMLOUVA",
    "Univerzita Příkladná",
    "se sídlem:\tOvocný trh 1, Praha 1",
    "IČO:\t\t00000001",
    "bankovní spojení:\t1/0100",
    "(dále jen „Objednatel“)",
    "Článek I.\nPrvní",
    numbered("1.", "Odstavec.", 1),
  ]);
  const party = PROFILE.roles.party;
  const measured = {
    ...PROFILE,
    roles: {
      ...PROFILE.roles,
      party: party === null ? null : { ...party, indentLeft: 851, size: 22 },
    },
  };

  test("values of one block start at one tab stop behind its widest label", () => {
    const { plan, note } = build(manifest, "keepSource", { profile: measured });
    // The widest label has 17 characters of 11 pt text behind the style's
    // indent. Every line's last tab ends there, so the values start at one
    // position; the line typed with two tabs has a stop a point in front
    // of it for its first.
    const shared = 851 + 2057 + 170;
    for (const start of ["se sídlem", "IČO", "bankovní"]) {
      expect(itemOf(plan, manifest, start)?.tabStops?.at(-1)).toBe(shared);
    }
    expect(itemOf(plan, manifest, "se sídlem")?.tabStops).toEqual([shared]);
    expect(itemOf(plan, manifest, "IČO")?.tabStops).toEqual([
      shared - 20,
      shared,
    ]);
    // A source that tabbed its values into place over default stops types
    // more tabs on a short label: each line still ends its last one there.
    const tabbed = manifestOf([
      "SMLOUVA",
      "Univerzita Příkladná",
      "se sídlem:\t\t\t\tOvocný trh 1, Praha 1",
      "IČO:\t\t\t\t\t00000001",
      "Článek I.\nPrvní",
      numbered("1.", "Odstavec.", 1),
    ]);
    const lines = build(tabbed, "keepSource", { profile: measured }).plan;
    const seat = itemOf(lines, tabbed, "se sídlem")?.tabStops ?? [];
    const number = itemOf(lines, tabbed, "IČO")?.tabStops ?? [];
    expect([seat.length, number.length]).toEqual([4, 5]);
    expect(seat.at(-1)).toBe(number.at(-1));
    // A line without a label and a tab has nothing to align.
    expect(itemOf(plan, manifest, "(dále jen")).not.toHaveProperty("tabStops");
    expect(itemOf(plan, manifest, "Univerzita")).not.toHaveProperty("tabStops");
    expect(note.items).toContainEqual({ kind: "partyLinesAligned", blocks: 3 });
  });

  test("lines with a colon label align outside the parties' block too, block by block", () => {
    const inArticle = manifestOf([
      "SMLOUVA",
      "Článek I.\nSmluvní strany",
      "Objednatel s.r.o.",
      "se sídlem: \tOvocný trh 1, Praha 1",
      "IČO: \t00000001",
      "(dále jen „Objednatel“)",
      numbered(
        "1.",
        "Odstavec s textem\tza tabulátorem, který není popiskou.",
        1,
      ),
    ]);
    // Every style of the template states the same indent here.
    const roles = { ...PROFILE.roles };
    for (const role of HOUSE_STYLE_ROLES) {
      const own = roles[role];
      roles[role] = own === null ? null : { ...own, indentLeft: 851, size: 22 };
    }
    const { plan } = build(inArticle, "keepSource", {
      profile: { ...PROFILE, roles },
    });
    const stops = itemOf(plan, inArticle, "se sídlem")?.tabStops;
    // "se sídlem: " has 11 characters of 11 pt text behind the indent.
    expect(stops).toEqual([851 + 1331 + 170]);
    expect(itemOf(plan, inArticle, "IČO")?.tabStops).toEqual(stops);
    // A numbered paragraph with a tab in it is text, not a label.
    expect(itemOf(plan, inArticle, "Odstavec s textem")).not.toHaveProperty(
      "tabStops",
    );
  });

  test("a party line laid out in a table takes the plain text style", () => {
    const table = inColumns(2, [
      "se sídlem:",
      "Ovocný trh 1, Praha 1",
      "IČO:",
      "00000001",
    ]);
    const { plan } = build({
      ...table,
      blocks: [
        ...manifestOf(["SMLOUVA"]).blocks.map((block) => ({
          ...block,
          id: "title",
        })),
        ...table.blocks,
        ...manifestOf(["Článek I.\nPrvní", "1.1\tOdstavec."]).blocks.map(
          (block, position) => ({ ...block, id: `after${String(position)}` }),
        ),
      ],
    });
    const nested = sourceItems(plan).flatMap((item) => item.nested ?? []);
    expect(nested.length).toBeGreaterThan(0);
    // The indent the template gives a party line on the page would only
    // narrow the column.
    for (const cell of nested) {
      expect(cell.styleId).toBe(PROFILE.roles.body?.styleId);
    }
    // Where the source sets such a line at the right of its cell, it stays
    // there, read as a party's line or not.
    const amounts = {
      ...table,
      blocks: table.blocks.map((block) =>
        block.text === "00000001" ? { ...block, alignment: "right" } : block,
      ),
    };
    const aligned = build({
      ...amounts,
      blocks: [
        ...manifestOf(["SMLOUVA"]).blocks.map((block) => ({
          ...block,
          id: "title",
        })),
        ...amounts.blocks,
        ...manifestOf(["Článek I.\nPrvní", "1.1\tOdstavec."]).blocks.map(
          (block, position) => ({ ...block, id: `after${String(position)}` }),
        ),
      ],
    });
    const number = sourceItems(aligned.plan)
      .flatMap((item) => item.nested ?? [])
      .find(
        ({ blockId }) =>
          blockId ===
          amounts.blocks.find(({ text }) => text === "00000001")?.id,
      );
    expect(number).toMatchObject({
      styleId: PROFILE.roles.body?.styleId,
      alignment: "right",
    });
  });

  test("a template whose style indent is not known leaves the lines as they are", () => {
    const { plan, note } = build(manifest);
    expect(
      sourceItems(plan).some(({ tabStops }) => tabStops !== undefined),
    ).toBe(false);
    expect(note.items.map(({ kind }) => kind)).not.toContain(
      "partyLinesAligned",
    );
  });
});

describe("buildTemplatePlan, lines that continue a numbered item", () => {
  const texts = [
    "SMLOUVA",
    "Článek I.\nPrvní",
    "Předmětem díla jsou tyto budovy:",
    "hlavní budova na nábřeží,",
    "k.ú. Malá Strana:",
    "budova včetně nádvoří",
    "Další odstavec článku u okraje.",
  ];
  const reading = (
    blockId: string,
    role: "title" | "articleHeading" | "clause1" | "roman" | "continuation",
  ) => ({
    blockId,
    role,
    confidence: 0.9,
    alternatives: [],
    mergedIntoBlockId: null,
  });
  const roles = [
    reading("p0", "title"),
    reading("p1", "articleHeading"),
    reading("p2", "clause1"),
    reading("p3", "roman"),
    reading("p4", "continuation"),
    reading("p5", "continuation"),
    reading("p6", "continuation"),
  ];
  const withIndents = (
    indents: Readonly<Record<number, { left: number; firstLine: number }>>,
  ): DocxBlockManifest => {
    const manifest = manifestOf(texts);
    return {
      ...manifest,
      blocks: manifest.blocks.map((block, position) => ({
        ...block,
        ...(position === 2 ? { label: "1.", hash: "c" } : {}),
        ...(position === 3 ? { label: "i.", hash: "i" } : {}),
        ...(indents[position] === undefined
          ? {}
          : { indent: indents[position] }),
      })),
    };
  };

  test("a line the source sets under an item's text stands under it in the output", () => {
    const manifest = withIndents({
      2: { left: 567, firstLine: -567 },
      3: { left: 1506, firstLine: -360 },
      // The first line starts where the item's text does, or further in.
      4: { left: 786, firstLine: 774 },
      5: { left: 1506, firstLine: 0 },
      // Back at the clause's text: no part of the item any more.
      6: { left: 567, firstLine: 0 },
    });
    const { plan, note } = build(manifest, "keepSource", { roles });
    const under = PROFILE.roles.roman?.numbering?.indent.left ?? 0;
    expect(under).toBeGreaterThan(0);
    expect(itemOf(plan, manifest, "k.ú.")?.indent).toEqual({ left: under });
    expect(itemOf(plan, manifest, "budova včetně")?.indent).toEqual({
      left: under,
    });
    expect(itemOf(plan, manifest, "Další odstavec")).not.toHaveProperty(
      "indent",
    );
    expect(note.items).toContainEqual({
      kind: "continuationsIndented",
      blocks: 2,
    });
    expect(note.items.map(({ kind }) => kind)).not.toContain("textLabelsHung");
  });

  test("without the source's indents nothing is moved", () => {
    const manifest = withIndents({});
    const { plan, note } = build(manifest, "keepSource", { roles });
    expect(itemOf(plan, manifest, "k.ú.")).not.toHaveProperty("indent");
    expect(note.items.map(({ kind }) => kind)).not.toContain(
      "continuationsIndented",
    );
  });
});

describe("buildTemplatePlan, a heading's title over two paragraphs", () => {
  test("the second line of the title is set as the heading is, not as text", () => {
    const manifest = manifestOf([
      "VERTRAG",
      "§ 1",
      {
        text: "Rechte an den Ergebnissen sowie",
        styleName: "heading 2",
        outlineLevel: 1,
      },
      {
        text: "an entstehenden Schutzrechten",
        styleName: "heading 2",
        outlineLevel: 1,
      },
      numbered("(1)", "Die Parteien vereinbaren Folgendes.", 1),
      "§ 2",
      { text: "Vergütung", styleName: "heading 2", outlineLevel: 1 },
      numbered("(1)", "Die Vergütung ist fällig.", 2),
    ]);
    const { plan } = build(manifest);
    const head = itemOf(plan, manifest, "§ 1");
    const second = itemOf(plan, manifest, "an entstehenden");
    // The first line joins the number; the second is a heading line of its
    // own, without a number, in the heading's style.
    expect(head?.mergeNext).toBeDefined();
    expect(second).toMatchObject({ styleId: head?.styleId, numbering: null });
    expect(second).not.toHaveProperty("mergeNext");
    // Text behind a one-line title stays text.
    expect(itemOf(plan, manifest, "Die Vergütung")?.styleId).not.toBe(
      head?.styleId,
    );
  });
});

describe("buildTemplatePlan, a typed article behind the document's numbered ones", () => {
  test("a mention in front of the numbered articles does not take a later typed article with it", () => {
    const article = (label: string, text: string) => ({
      ...numbered(label, text, 1),
      styleName: "heading 1",
      outlineLevel: 0,
    });
    const manifest = manifestOf([
      "AGREEMENT",
      // A summary names the second article.
      { text: "Article 2 Term", styleName: "heading 5", outlineLevel: 4 },
      "The term is summarised here.",
      article("1.", "Definitions"),
      numbered("1.1", "In this agreement the following terms apply.", 1),
      article("2.", "Term"),
      numbered("2.1", "The agreement runs for one year.", 1),
      // The third article is typed, and is the document's own.
      { text: "Article 3 Notices", styleName: "heading 1", outlineLevel: 0 },
      "Notices are given in writing.",
    ]);
    const index = buildLabelIndex(manifest);
    expect(
      index.entryByBlockId.get(blockIdOf(manifest, "Article 3 Notices")),
    ).toMatchObject({ level: "article", origin: "manual" });
    expect(
      index.entryByBlockId.has(blockIdOf(manifest, "Article 2 Term")),
    ).toBe(false);
  });
});

describe("buildTemplatePlan, a number two typed articles have", () => {
  test("a heading that counts on stays in the index where the document has a typed article of that number", () => {
    const manifest = manifestOf([
      "AGREEMENT",
      // A typed article of the document's own, out of the numbered run.
      { text: "Article 3 Notices", styleName: "heading 1", outlineLevel: 0 },
      "Notices are given in writing.",
      {
        ...numbered("1.", "Definitions", 1),
        styleName: "heading 1",
        outlineLevel: 0,
      },
      numbered("1.1", "In this agreement the following terms apply.", 1),
      // A part that counts its own articles, up to the same number.
      { text: "Article 1 Subject", styleName: "heading 5", outlineLevel: 4 },
      "This contract implements the agreement.",
      { text: "Article 2 Price", styleName: "heading 5", outlineLevel: 4 },
      "The price is fixed.",
      { text: "Article 3 Term", styleName: "heading 5", outlineLevel: 4 },
      "The term is one year as stated in Article 3.",
    ]);
    const index = buildLabelIndex(manifest);
    // Both articles of that number are in the index, so a citation of it
    // has two places it may mean.
    expect(
      index.entryByBlockId.has(blockIdOf(manifest, "Article 3 Notices")),
    ).toBe(true);
    expect(
      index.entryByBlockId.has(blockIdOf(manifest, "Article 3 Term")),
    ).toBe(true);
    expect(
      index.entryByBlockId.has(blockIdOf(manifest, "Article 2 Price")),
    ).toBe(false);
    // And the citation is linked to neither.
    const { plan } = build(manifest);
    expect(
      (plan.references ?? []).filter(
        ({ blockId }) => blockId === blockIdOf(manifest, "The term is one"),
      ),
    ).toEqual([]);
  });
});

describe("buildTemplatePlan, an article heading the index does not count", () => {
  test("a heading that opens with an article's name is set as a heading and keeps its typed label", () => {
    const article = (label: string, text: string) => ({
      ...numbered(label, text, 1),
      styleName: "heading 1",
      outlineLevel: 0,
    });
    const manifest = manifestOf([
      "AGREEMENT",
      article("1.", "Definitions"),
      numbered("1.1", "In this agreement the following terms apply.", 1),
      article("2.", "Term"),
      numbered("2.1", "The agreement runs for one year.", 1),
      // A model contract behind the agreement counts its articles again.
      {
        text: "Article 1 Subject matter",
        styleName: "heading 5",
        outlineLevel: 4,
      },
      "This specific contract implements the agreement.",
    ]);
    const { plan } = build(manifest);
    const typed = itemOf(plan, manifest, "Article 1 Subject");
    expect(typed).toMatchObject({
      styleId: PROFILE.roles.articleHeading?.styleId,
      numbering: null,
    });
    expect(typed).not.toHaveProperty("stripLabel");
    // The numbered articles keep their numbers.
    expect(itemOf(plan, manifest, "Definitions")?.numbering).not.toBeNull();
  });

  test("the articles of a part that counts its own are set alike, also past the document's last number", () => {
    const article = (label: string, text: string) => ({
      ...numbered(label, text, 1),
      styleName: "heading 1",
      outlineLevel: 0,
    });
    const own = (text: string) => ({
      text,
      styleName: "heading 5",
      outlineLevel: 4,
    });
    const manifest = manifestOf([
      "AGREEMENT",
      article("1.", "Definitions"),
      numbered("1.1", "In this agreement the following terms apply.", 1),
      article("2.", "Term"),
      numbered("2.1", "The agreement runs for one year.", 1),
      // The model contract has more articles than the agreement.
      own("Article 1 Subject matter"),
      "This specific contract implements the agreement.",
      own("Article 2 Price"),
      "The price is fixed.",
      own("Article 3 Communication details"),
      "Notices go to the addresses below.",
      own("Article 4 Guarantee"),
      "A guarantee is provided on request.",
    ]);
    const { plan } = build(manifest);
    for (const start of [
      "Article 1 Subject",
      "Article 2 Price",
      "Article 3 Communication",
      "Article 4 Guarantee",
    ]) {
      const typed = itemOf(plan, manifest, start);
      expect(typed).toMatchObject({
        styleId: PROFILE.roles.articleHeading?.styleId,
        numbering: null,
      });
      expect(typed).not.toHaveProperty("stripLabel");
    }
    // The label of a heading that counts on is the heading's own name: it
    // is read as no citation.
    const { note } = build(manifest);
    for (const start of ["Article 3 Communication", "Article 4 Guarantee"]) {
      expect(
        note.items.filter(
          (item) =>
            item.kind === "referenceUnlinked" &&
            item.blockId === blockIdOf(manifest, start),
        ),
      ).toEqual([]);
    }
  });
});
