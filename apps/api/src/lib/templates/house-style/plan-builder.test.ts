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

  test("a paragraph's own page start is carried, except on the document's first block", () => {
    const { plan } = build(
      withFacts(["SMLOUVA", "Text.", "Příloha č. 1", "Seznam."], {
        0: { pageBreakBefore: true },
        2: { pageBreakBefore: true },
      }),
    );
    expect(starts(plan)).toEqual(["p2"]);
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

  test("a section that begins on a new page begins one; its layout is noted when it is another", () => {
    const { plan, note } = build(
      withFacts(
        ["SMLOUVA", "Text.", "Příloha č. 1", "Tabulka.", "Dodatek.", "Konec."],
        {
          1: { endsSection: true },
          2: { sectionIndex: 1 },
          3: { sectionIndex: 1, endsSection: true },
          4: { sectionIndex: 2, endsSection: true },
          5: { sectionIndex: 3 },
        },
        [
          section(0, "nextPage"),
          section(1, "nextPage", "landscape"),
          section(2, "oddPage"),
          section(3, "continuous"),
        ],
      ),
    );
    expect(starts(plan)).toEqual(["p2", "p4"]);
    expect(notes(note, "sectionLayoutNotKept")).toEqual([
      {
        kind: "sectionLayoutNotKept",
        afterBlockId: "p1",
        start: "nextPage",
        pageDiffers: true,
        columns: 1,
      },
      {
        kind: "sectionLayoutNotKept",
        afterBlockId: "p4",
        start: "continuous",
        pageDiffers: false,
        columns: 1,
      },
    ]);
  });

  test("a title that starts a page is not joined to the heading before it", () => {
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
    for (const facts of [
      // By its own formatting, and by the section that ends in front of it.
      { 2: { pageBreakBefore: true } } as const,
      { 1: { endsSection: true }, 2: { sectionIndex: 1 } } as const,
    ]) {
      const manifest = withFacts(texts, facts, [
        section(0, "nextPage"),
        section(1, "nextPage"),
      ]);
      const { plan } = build(manifest, "keepSource", { roles });
      expect(itemOf(plan, manifest, "Článek I.")?.mergeNext).toBeUndefined();
      expect(starts(plan)).toEqual(["p2"]);
    }
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
