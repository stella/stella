import { describe, expect, test } from "bun:test";

import type {
  DocxBlockManifest,
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
import { proposeBlockRoles } from "@/api/lib/templates/house-style/role-proposer";
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
    expect(plan.numberingPatches).toContainEqual({
      abstractNumId: 4,
      ilvl: 0,
      numFmt: "upperRoman",
      lvlText: "Článek %1.",
      // The document breaks its headings after the number: a space follows
      // the number, and the centred heading's level loses the indent that
      // would move its second line off the number's centre.
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
      mergeNext: "lineBreak",
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

  test("one heading with a break is enough to take the centred level's indent away", () => {
    const manifest = manifestOf([
      "SMLOUVA",
      "Článek I. První",
      numbered("1.", "Odstavec.", 1),
      "Článek II. Druhý",
      numbered("1.", "Odstavec.", 2),
      "Článek III.\nTřetí, jako jediný zalomený",
      numbered("1.", "Odstavec.", 3),
    ]);
    const { plan } = build(manifest);
    // Most headings run on one line: the tab after the number stays.
    expect(plan.numberingPatches).toContainEqual({
      abstractNumId: 4,
      ilvl: 0,
      numFmt: "upperRoman",
      lvlText: "Článek %1.",
      indent: { left: 0, hanging: 0 },
    });
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
        { abstractNumId: 4, ilvl: 6, numFmt: "bullet", lvlText: "•" },
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
    // The template's formats stay; only the broken headings are settled.
    expect(plan.numberingPatches).toEqual([
      {
        abstractNumId: 4,
        ilvl: 0,
        suff: "space",
        indent: { left: 0, hanging: 0 },
      },
    ]);
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
    // reference to the article stays text.
    expect(note.items).toContainEqual(
      expect.objectContaining({
        kind: "referenceUnlinked",
        blockId: citing,
        reason: "punctuatedLevelWords",
      }),
    );
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
