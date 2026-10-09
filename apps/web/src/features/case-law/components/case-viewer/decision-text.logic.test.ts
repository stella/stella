import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  annotationsOverlappingTextSpan,
  apparatusBlockIds,
  courtHeadnoteOrigin,
  decisionCaseName,
  decisionDisplayReference,
  editorialSupplementBlocks,
  footnoteParts,
  resolveDecisionLinkOverlaps,
  visibleDecisionBlocks,
} from "@stll/decision-reader/decision-text.logic";
import { buildDocumentAstSearchPieces } from "@stll/decision-reader/document-ast-text";
import type { HeadnoteOrigin } from "@stll/decision-reader/headnote-block";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type {
  Block,
  DocumentAst,
  ParagraphNote,
  ParagraphRole,
} from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

test("every cross-kind overlap accounts for displaced provisions and retains adjacent links", () => {
  for (const kind of ["decision", "statute", "external"]) {
    const competing = { key: `${kind}:citation`, start: 0, end: 20 };
    const displaced = { key: "provision:displaced", start: 5, end: 10 };
    const adjacent = { key: "provision:adjacent", start: 20, end: 25 };
    for (const links of [
      [competing, displaced, adjacent],
      [adjacent, displaced, competing],
    ]) {
      expect(resolveDecisionLinkOverlaps(links)).toEqual({
        links: [competing, adjacent],
        failures: [{ id: "displaced", reason: "span-overlap" }],
      });
    }
    const longerProvision = { key: "provision:retained", start: 0, end: 25 };
    expect(resolveDecisionLinkOverlaps([competing, longerProvision])).toEqual({
      links: [longerProvision],
      failures: [],
    });
  }
});

test("overlap accounting distinguishes discarded spans even when their source keys coincide", () => {
  const first = { key: "provision:repeated", start: 0, end: 10 };
  const overlapping = { key: "provision:repeated", start: 5, end: 15 };
  expect(resolveDecisionLinkOverlaps([first, overlapping])).toEqual({
    links: [first],
    failures: [{ id: "repeated", reason: "span-overlap" }],
  });
});

test("final link disposition accounts for every nested provision across generated offsets", () => {
  assertProperty(
    "final link disposition accounts for every nested provision across generated offsets",
    fc.property(fc.nat(), fc.integer({ min: 3 }), (start, length) => {
      for (const kind of ["decision", "statute", "external"]) {
        const outer = { key: `${kind}:outer`, start, end: start + length };
        const inner = {
          key: "provision:inner",
          start: start + 1,
          end: start + length - 1,
        };
        const after = {
          key: "provision:after",
          start: outer.end,
          end: outer.end + 1,
        };
        for (const links of [
          [inner, outer, after],
          [after, outer, inner],
        ]) {
          const disposition = resolveDecisionLinkOverlaps(links);
          expect(disposition.links).toEqual([outer, after]);
          expect(disposition.failures).toEqual([
            { id: "inner", reason: "span-overlap" },
          ]);
          expect(disposition.links.length + disposition.failures.length).toBe(
            links.length,
          );
        }
      }
    }),
  );
});

const titleBlock = (plainText: string): Block => ({
  anchorId: "title",
  id: "title",
  inlines: [{ text: plainText, type: "text" }],
  level: 1,
  plainText,
  role: "decision-title",
  type: "heading",
});

const astOf = (blocks: Block[]): DocumentAst => ({
  version: 1,
  source: { system: "test", documentId: "1", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: "347 U.S. 483",
    ecli: null,
    court: "Supreme Court",
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks,
});

test("storage-resolved fulltext placement keeps the rendered paragraph ids and characters", () => {
  const fulltext =
    "  Žalobce použil § 42.\nPokračování věty.\n\n\nOdkaz na 2 As 2/2025.  ";
  const blocks = visibleDecisionBlocks(
    null,
    DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    fulltext,
  );
  expect(buildDocumentAstSearchPieces(blocks)).toEqual([
    { id: "fulltext:0", text: "  Žalobce použil § 42.\nPokračování věty." },
    { id: "fulltext:1", text: "Odkaz na 2 As 2/2025.  " },
  ]);
  expect(
    visibleDecisionBlocks(null, DECISION_IDENTIFIER_TYPES.CASE_NUMBER, null),
  ).toEqual([]);
  expect(
    visibleDecisionBlocks(
      astOf([]),
      DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      fulltext,
    ),
  ).toEqual(blocks);
});

describe("citable case name", () => {
  test("takes the name off a title of the “Name, Cite” shape", () => {
    expect(
      decisionCaseName({
        ast: astOf([titleBlock("Brown v. Board of Education, 347 U.S. 483")]),
        caseNumber: "347 U.S. 483",
      }),
    ).toBe("Brown v. Board of Education");
  });

  test("a heading that only names the court is not a case name", () => {
    expect(
      decisionCaseName({
        ast: astOf([titleBlock("JUDGMENT OF THE COURT (Grand Chamber)")]),
        caseNumber: "C-311/18",
      }),
    ).toBeNull();
    expect(
      decisionCaseName({ ast: astOf([]), caseNumber: "C-311/18" }),
    ).toBeNull();
  });

  test("an unparsed document has no case name", () => {
    expect(decisionCaseName({ ast: null, caseNumber: "C-311/18" })).toBeNull();
  });
});

const caseNumberHeader = (plainText: string): Block => ({
  anchorId: "case-number",
  id: "case-number",
  inlines: [{ text: plainText, type: "text" }],
  plainText,
  role: "case-number",
  type: "paragraph",
});

describe("the reference line's reference", () => {
  test("a docket primary takes the document's own case-number header", () => {
    expect(
      decisionDisplayReference({
        ast: astOf([caseNumberHeader("sp. zn. 1 As 1/2026")]),
        caseNumber: "1 As 1/2026",
        caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      }),
    ).toBe("sp. zn. 1 As 1/2026");
  });

  test("a citation primary is not displaced by the docket header", () => {
    expect(
      decisionDisplayReference({
        ast: astOf([caseNumberHeader("No. 1")]),
        caseNumber: "347 U.S. 483",
        caseNumberType: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
      }),
    ).toBe("347 U.S. 483");
  });

  test("falls back to the stored primary when the document has no header", () => {
    expect(
      decisionDisplayReference({
        ast: null,
        caseNumber: "1 As 1/2026",
        caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      }),
    ).toBe("1 As 1/2026");
  });
});

describe("annotations crossing links", () => {
  test("keeps every intersecting mark over the linked text", () => {
    const annotations = [
      { id: "contains", startOffset: 2, endOffset: 20 },
      { id: "starts-inside", startOffset: 8, endOffset: 18 },
      { id: "ends-inside", startOffset: 0, endOffset: 7 },
      { id: "before", startOffset: 0, endOffset: 5 },
      { id: "after", startOffset: 10, endOffset: 14 },
    ];

    expect(
      annotationsOverlappingTextSpan(annotations, { start: 5, end: 10 }).map(
        ({ id }) => id,
      ),
    ).toEqual(["contains", "starts-inside", "ends-inside"]);
  });
});

describe("editorial supplement blocks", () => {
  test("uses publisher-preserved blank lines as the authoritative boundaries", () => {
    const source =
      "Analytická právní věta\n\nPlošné údaje eJustice zpracovala.Nespojená věta zůstává v témže zdrojovém bloku.\n\nNávrh a řízení před Ústavním soudem";

    expect(
      editorialSupplementBlocks(source).map(({ text, type }) => ({
        text,
        type,
      })),
    ).toEqual([
      { text: "Analytická právní věta", type: "heading" },
      {
        text: "Plošné údaje eJustice zpracovala.Nespojená věta zůstává v témže zdrojovém bloku.",
        type: "paragraph",
      },
      {
        text: "Návrh a řízení před Ústavním soudem",
        type: "heading",
      },
    ]);
  });

  test("recovers NALUS headings and paragraph boundaries without changing offsets", () => {
    const source =
      "Analytická právní větaPlošné shromažďování údajů je nepřípustné.Návrh a řízení před Ústavním soudemPlénum návrhu vyhovělo.Dle navrhovatelů šlo o zásah.Odůvodnění rozhodnutí Ústavního souduV souvislosti s návrhem soud rozhodl.";
    const blocks = editorialSupplementBlocks(source);

    expect(blocks.map(({ text, type }) => ({ text, type }))).toEqual([
      { text: "Analytická právní věta", type: "heading" },
      {
        text: "Plošné shromažďování údajů je nepřípustné.",
        type: "paragraph",
      },
      {
        text: "Návrh a řízení před Ústavním soudem",
        type: "heading",
      },
      { text: "Plénum návrhu vyhovělo.", type: "paragraph" },
      { text: "Dle navrhovatelů šlo o zásah.", type: "paragraph" },
      {
        text: "Odůvodnění rozhodnutí Ústavního soudu",
        type: "heading",
      },
      {
        text: "V souvislosti s návrhem soud rozhodl.",
        type: "paragraph",
      },
    ]);
    for (const block of blocks) {
      expect(source.slice(block.start, block.end)).toBe(block.text);
    }
  });

  test("does not split an early mixed-case word", () => {
    expect(
      editorialSupplementBlocks("Služba eJustice zůstala dostupná."),
    ).toEqual([
      {
        end: "Služba eJustice zůstala dostupná.".length,
        start: 0,
        text: "Služba eJustice zůstala dostupná.",
        type: "paragraph",
      },
    ]);
  });
});

const ast = {
  version: 1,
  source: { system: "test", documentId: "1", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: "1 As 1/2026",
    ecli: null,
    court: "Nejvyšší správní soud",
    decisionDate: null,
    decisionType: "Rozsudek",
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      id: "case-number",
      anchorId: "case-number",
      type: "paragraph",
      role: "case-number",
      inlines: [{ type: "text", text: "1 As 1/2026" }],
      plainText: "1 As 1/2026",
    },
    {
      id: "title",
      anchorId: "title",
      type: "heading",
      level: 1,
      role: "decision-title",
      inlines: [{ type: "text", text: "JMÉNEM REPUBLIKY" }],
      plainText: "JMÉNEM REPUBLIKY",
    },
    {
      id: "related",
      anchorId: "related",
      type: "table",
      role: "related-proceedings",
      rows: [],
      plainText: "Related proceedings",
    },
    {
      id: "body",
      anchorId: "body",
      type: "paragraph",
      inlines: [{ type: "text", text: "Body" }],
      plainText: "Body",
    },
  ],
} as const satisfies DocumentAst;

describe("visible decision blocks", () => {
  test("keeps semantic headings while removing separately rendered metadata", () => {
    expect(
      visibleDecisionBlocks(ast, DECISION_IDENTIFIER_TYPES.CASE_NUMBER).map(
        (block) => block.id,
      ),
    ).toEqual(["title", "body"]);
  });

  test("keeps the docket header when the primary reference is not a docket", () => {
    expect(
      visibleDecisionBlocks(
        ast,
        DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
      ).map((block) => block.id),
    ).toEqual(["case-number", "title", "body"]);
  });

  test("repairs legacy same-line Roman headings after Odůvodnění", () => {
    const legacyAst = {
      ...ast,
      blocks: [
        {
          anchorId: "reasoning",
          id: "reasoning",
          inlines: [{ text: "Odůvodnění:", type: "text" }],
          level: 2,
          plainText: "Odůvodnění:",
          role: "section-heading",
          type: "heading",
        },
        {
          anchorId: "p-127",
          id: "b127",
          inlines: [{ text: "VIII. Vlastní přezkum", type: "text" }],
          plainText: "VIII. Vlastní přezkum",
          type: "paragraph",
        },
        {
          anchorId: "p-128",
          id: "b128",
          inlines: [{ text: "VIII. A) Tzv. data retention", type: "text" }],
          plainText: "VIII. A) Tzv. data retention",
          type: "paragraph",
        },
      ],
    } as const satisfies DocumentAst;

    expect(
      visibleDecisionBlocks(
        legacyAst,
        DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      ).map((block) => ({
        anchorId: block.anchorId,
        level: block.type === "heading" ? block.level : null,
        text: block.plainText,
        type: block.type,
      })),
    ).toEqual([
      {
        anchorId: "reasoning",
        level: 2,
        text: "Odůvodnění:",
        type: "heading",
      },
      {
        anchorId: "p-127",
        level: 3,
        text: "VIII. Vlastní přezkum",
        type: "heading",
      },
      {
        anchorId: "p-128",
        level: 4,
        text: "VIII. A) Tzv. data retention",
        type: "heading",
      },
    ]);
  });
});

const noteBlocks = (notes: readonly (ParagraphNote | undefined)[]): Block[] =>
  notes.map((note, index) => ({
    id: `b${String(index)}`,
    anchorId: `b-${String(index)}`,
    type: "paragraph",
    ...(note === undefined ? {} : { note }),
    inlines: [{ type: "text", text: "Note" }],
    plainText: "Note",
  }));

describe("footnote parts", () => {
  test("a note printed over several paragraphs opens once and jumps back from its head", () => {
    const blocks = noteBlocks([
      { type: "footnote", label: "1", noteId: "n1" },
      { type: "footnote", label: "1", noteId: "n1" },
      { type: "footnote", label: "1", noteId: "n1" },
    ]);
    const { headIds, backJumpAnchorByLastId } = footnoteParts(blocks);

    expect([...headIds]).toEqual(["b0"]);
    expect([...backJumpAnchorByLastId]).toEqual([["b2", "b-0"]]);
  });

  test("a table between note paragraphs stays inside the same reader note", () => {
    const blocks: Block[] = [
      ...noteBlocks([{ type: "footnote", label: "5", noteId: "n5" }]),
      {
        id: "table",
        anchorId: "table-anchor",
        type: "table",
        note: { type: "footnote", label: "5", noteId: "n5" },
        rows: [
          [{ inlines: [{ type: "text", text: "Data" }], plainText: "Data" }],
        ],
        plainText: "Data",
      },
      {
        id: "b2",
        anchorId: "b-2",
        type: "paragraph",
        note: { type: "footnote", label: "5", noteId: "n5" },
        inlines: [{ type: "text", text: "Note" }],
        plainText: "Note",
      },
    ];
    const { headIds, backJumpAnchorByLastId } = footnoteParts(blocks);

    expect([...headIds]).toEqual(["b0"]);
    expect([...backJumpAnchorByLastId]).toEqual([["b2", "b-0"]]);
  });

  test("notes with no shared identity are each complete by themselves", () => {
    const { headIds, backJumpAnchorByLastId } = footnoteParts(
      noteBlocks([
        { type: "footnote", label: "1" },
        { type: "footnote", label: "2" },
      ]),
    );

    expect([...headIds]).toEqual(["b0", "b1"]);
    expect([...backJumpAnchorByLastId]).toEqual([
      ["b0", "b-0"],
      ["b1", "b-1"],
    ]);
  });

  test("adjacent notes with different identities do not merge", () => {
    const { headIds, backJumpAnchorByLastId } = footnoteParts(
      noteBlocks([
        { type: "footnote", label: "1", noteId: "n1" },
        { type: "footnote", label: "2", noteId: "n2" },
      ]),
    );

    expect([...headIds]).toEqual(["b0", "b1"]);
    expect([...backJumpAnchorByLastId]).toEqual([
      ["b0", "b-0"],
      ["b1", "b-1"],
    ]);
  });

  test("a body paragraph between two parts breaks the run", () => {
    const { headIds, backJumpAnchorByLastId } = footnoteParts(
      noteBlocks([
        { type: "footnote", label: "1", noteId: "n1" },
        undefined,
        { type: "footnote", label: "1", noteId: "n1" },
      ]),
    );

    expect([...headIds]).toEqual(["b0", "b2"]);
    expect([...backJumpAnchorByLastId]).toEqual([
      ["b0", "b-0"],
      ["b2", "b-2"],
    ]);
  });

  test("a body paragraph is neither a head nor a last part", () => {
    const { headIds, backJumpAnchorByLastId } = footnoteParts(
      noteBlocks([undefined]),
    );

    expect([...headIds]).toEqual([]);
    expect(backJumpAnchorByLastId.size).toBe(0);
  });
});

describe("apparatus block ids", () => {
  const roleBlocks = (roles: readonly (ParagraphRole | undefined)[]): Block[] =>
    roles.map((role, index) => ({
      id: role ?? "no-role",
      anchorId: `a-${String(index)}`,
      type: "paragraph",
      ...(role === undefined ? {} : { role }),
      inlines: [],
      plainText: "",
    }));

  test("folds every publisher-authored role, and leaves the bench alone", () => {
    expect([
      ...apparatusBlockIds(
        roleBlocks([
          "apparatus",
          "syllabus",
          "headnotes",
          "summary",
          "counsel",
          "panel",
          "intro",
          undefined,
        ]),
      ),
    ]).toEqual(["apparatus", "syllabus", "headnotes", "summary", "counsel"]);
  });
});

// The chip is drawn from the tier, and a read that could not reach the court
// registry states no abbreviation beside its placeholder tier. Everything the
// read left open is the same answer: no chip, and the court named in words.
describe("the mark on the court's own headnote", () => {
  test("carries the chip where the read abbreviated the court", () => {
    expect(
      courtHeadnoteOrigin({ courtAbbreviation: "NS", courtTier: "supreme" }),
    ).toEqual({ type: "court", chip: { abbreviation: "NS", tier: "supreme" } });
  });

  test("invents no chip for a court the read did not resolve", () => {
    const unmarked: HeadnoteOrigin = { type: "court", chip: null };

    expect(
      courtHeadnoteOrigin({ courtAbbreviation: null, courtTier: "other" }),
    ).toEqual(unmarked);
    expect(
      courtHeadnoteOrigin({ courtAbbreviation: "", courtTier: "supreme" }),
    ).toEqual(unmarked);
  });
});
