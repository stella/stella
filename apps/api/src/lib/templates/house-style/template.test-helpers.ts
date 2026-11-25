// A template inspection for the tests of this directory: an invented
// contract template with one outline list, a recital list, a party list,
// sample text, a signature table and an annex heading.

import type {
  DocxBlock,
  TemplateField,
  TemplateInspection,
  TemplateListLevel,
  TemplateStyle,
} from "@/api/lib/templates/house-style/folio-contract";

export const OUTLINE_LIST = 18;
const OUTLINE_DEFINITION = 4;
const RECITAL_LIST = 19;
const PARTY_LIST = 20;

type StyleSpec = [styleId: string, name: string, numPr?: [number, number]];

/** Styles the invented template centres. */
const CENTRED: ReadonlySet<string> = new Set(["Title", "Article"]);

const style = ([styleId, name, numPr]: StyleSpec): TemplateStyle => ({
  styleId,
  name,
  type: "paragraph",
  basedOn: styleId === "Normal" ? null : "Normal",
  numPr: numPr === undefined ? null : { numId: numPr[0], ilvl: numPr[1] },
  outlineLvl: null,
  alignment: CENTRED.has(styleId) ? "center" : null,
  isDefault: styleId === "Normal",
});

const STYLES: StyleSpec[] = [
  ["Normal", "Normal"],
  ["Title", "Title centred"],
  ["Body", "Body text"],
  ["Indent", "Body indent"],
  ["Party", "Parties", [PARTY_LIST, 0]],
  ["Recital", "Recital numbered", [RECITAL_LIST, 0]],
  ["Article", "Heading article", [OUTLINE_LIST, 0]],
  ["Clause1", "Clause 1.1", [OUTLINE_LIST, 1]],
  ["Clause2", "Clause 1.1.1", [OUTLINE_LIST, 2]],
  ["Letter", "Clause a)", [OUTLINE_LIST, 3]],
  ["Roman", "Clause (i)", [OUTLINE_LIST, 4]],
  ["Signature", "Signature"],
  ["Annex", "Annex heading"],
  ["TOC1", "toc 1"],
];

const LEVEL_STEP = 567;

const level = (
  ilvl: number,
  numFmt: string,
  lvlText: string,
  pStyle: string | null = null,
): TemplateListLevel => ({
  ilvl,
  numFmt,
  lvlText,
  start: 1,
  pStyle,
  // Each level hangs its number in front of the text, one step deeper.
  indent: {
    left: (ilvl + 1) * LEVEL_STEP,
    hanging: LEVEL_STEP,
    firstLine: null,
  },
});

type BlockSpec = {
  id: string;
  text?: string;
  styleId?: string;
  label?: string;
  numbering?: [number, number, number];
  cells?: string[];
};

const block = (
  { id, text = "", styleId, label, numbering, cells }: BlockSpec,
  index: number,
): DocxBlock => ({
  id,
  index,
  kind: cells === undefined ? "paragraph" : "table",
  text,
  label: label ?? null,
  numbering:
    numbering === undefined
      ? null
      : {
          numId: numbering[0],
          ilvl: numbering[1],
          abstractNumId: numbering[2],
        },
  styleId: styleId ?? null,
  styleName: STYLES.find(([candidate]) => candidate === styleId)?.[1] ?? null,
  outlineLevel: null,
  sectionIndex: 0,
  hash: `h-${id}`,
  ...(cells === undefined
    ? {}
    : { cells: cells.map((cell, col) => ({ row: 0, col, blockIds: [cell] })) }),
});

const outline = (ilvl: number): [number, number, number] => [
  OUTLINE_LIST,
  ilvl,
  OUTLINE_DEFINITION,
];

const SAMPLE: BlockSpec[] = [
  { id: "p0", text: "AGREEMENT", styleId: "Title" },
  { id: "p1", text: "between:", styleId: "Body" },
  {
    id: "p2",
    text: "[company name]",
    styleId: "Party",
    label: "1.",
    numbering: [PARTY_LIST, 0, 3],
  },
  { id: "p3", text: "registered office […]", styleId: "Indent" },
  { id: "p4", text: "Contents", styleId: "Body" },
  { id: "p5", text: "Art. 1\tHeading\t2", styleId: "TOC1" },
  { id: "p6", text: "Annex 1\t4", styleId: "TOC1" },
  { id: "p7", styleId: "Body" },
  {
    id: "p8",
    styleId: "Recital",
    label: "A.",
    numbering: [RECITAL_LIST, 0, 0],
  },
  {
    id: "p9",
    text: "Heading",
    styleId: "Article",
    label: "Art. 1",
    numbering: outline(0),
  },
  { id: "p10", styleId: "Clause1", label: "1.1.", numbering: outline(1) },
  { id: "p11", styleId: "Letter", label: "a)", numbering: outline(3) },
  { id: "p12", styleId: "Roman", label: "(i)", numbering: outline(4) },
  { id: "t13", cells: ["p14", "p15"] },
  { id: "p14", text: "………………………", styleId: "Signature" },
  { id: "p15", text: "[name]", styleId: "Signature" },
  { id: "p16", text: "Annex No. \nTitle", styleId: "Annex" },
];

type TemplateOptions = {
  /** `filled` shows entries of the sample; `empty` is the bare field. */
  contents?: "filled" | "empty";
  /** Blocks put in front of the sample, e.g. a letterhead table. */
  front?: BlockSpec[];
};

/** An invented contract template as the engine inspects it. */
export const contractTemplate = ({
  contents = "filled",
  front = [],
}: TemplateOptions = {}): TemplateInspection => {
  const fields: TemplateField[] = [
    { part: "word/document.xml", kind: "TOC", blockId: "p5", endBlockId: "p7" },
    { part: "word/document.xml", kind: "AUTONUMLGL", blockId: "p16" },
    { part: "word/document.xml", kind: "FILLIN", blockId: "p1" },
    { part: "word/footer1.xml", kind: "PAGE" },
    { part: "word/footer2.xml", kind: "FILENAME" },
    { part: "word/footer2.xml", kind: "TIME" },
  ];
  if (contents === "filled") {
    fields.push(
      { part: "word/document.xml", kind: "PAGEREF", blockId: "p5" },
      { part: "word/document.xml", kind: "PAGEREF", blockId: "p6" },
    );
  }
  return {
    sha256: "a".repeat(64),
    blocks: [...front, ...SAMPLE].map(block),
    styles: STYLES.map(style),
    numbering: {
      abstractNums: [
        {
          abstractNumId: 0,
          levels: [level(0, "upperLetter", "%1.", "Recital")],
        },
        { abstractNumId: 3, levels: [level(0, "decimal", "%1.", "Party")] },
        {
          abstractNumId: OUTLINE_DEFINITION,
          levels: [
            level(0, "decimal", "Art. %1", "Article"),
            level(1, "decimal", "%1.%2.", "Clause1"),
            level(2, "decimal", "%1.%2.%3.", "Clause2"),
            level(3, "lowerLetter", "%4)", "Letter"),
            level(4, "lowerRoman", "(%5)", "Roman"),
            level(5, "lowerRoman", "(%6)"),
            level(6, "decimal", "%7."),
            level(7, "lowerLetter", "%8."),
            level(8, "lowerRoman", "%9."),
          ],
        },
      ],
      nums: [
        { numId: OUTLINE_LIST, abstractNumId: OUTLINE_DEFINITION },
        { numId: RECITAL_LIST, abstractNumId: 0 },
        { numId: PARTY_LIST, abstractNumId: 3 },
      ],
    },
    fields,
  };
};

/** A letterhead: a table of sender details in front of the sample. */
export const LETTERHEAD: BlockSpec[] = [
  { id: "t90", cells: ["p91", "p92"] },
  { id: "p91", text: "Vltavín & Horák, advokáti", styleId: "Normal" },
  { id: "p92", text: "Dlouhá 1, Praha", styleId: "Normal" },
];
