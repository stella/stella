import type {
  BlockContent,
  Document,
  Paragraph,
  Run,
  SectionProperties,
  StyleDefinitions,
  Table,
  TableCell,
  TableRow,
} from "../model/document";
import type { NumberingDefinitions } from "../model/lists";
import { parseLegalSource } from "./parser";
import type {
  Autofix,
  CompiledLegalDocument,
  LegalDraft,
  LegalDraftBlock,
  LegalDraftDiagnostic,
  LegalNumberingProfile,
  LegalPageOrientation,
  LegalPageSize,
  LegalSourceCompileOptions,
  LegalSourceCompileResult,
} from "./types";
import { validateLegalDraft } from "./validate";

const LEGAL_NUMBERING_ID = 1;
const LEGAL_ABSTRACT_NUMBERING_ID = 1;
const BULLET_NUMBERING_ID = 2;
const BULLET_ABSTRACT_NUMBERING_ID = 2;
const CHECKLIST_NUMBERING_ID = 3;
const CHECKLIST_ABSTRACT_NUMBERING_ID = 3;

// Underscore sequence reads as the conventional signature rule in
// Word and stays inside a half-page column without wrapping at body
// font size.
const SIGNATURE_LINE = "_".repeat(28);

export const compileLegalSourceToDocument = (
  source: string,
  options: LegalSourceCompileOptions = {},
): LegalSourceCompileResult => {
  const parsed = parseLegalSource(
    source,
    options.titleFallback ? { titleFallback: options.titleFallback } : {},
  );
  const validationDiagnostics = validateLegalDraft(parsed.draft);
  const diagnostics = [...parsed.diagnostics, ...validationDiagnostics];
  const errors = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );

  if (errors.length > 0) {
    return {
      status: "needs_llm_repair",
      draft: parsed.draft,
      fixes: parsed.fixes,
      errors,
    };
  }

  const document = draftToDocument(parsed.draft);
  return {
    status: "ok",
    document,
    draft: parsed.draft,
    fixes: parsed.fixes,
    warnings: diagnostics.filter(
      (diagnostic) => diagnostic.severity === "warning",
    ),
  };
};

export const draftToDocument = (draft: LegalDraft): Document => {
  const content: BlockContent[] = [];
  const title = draft.meta.title ?? "Untitled document";
  const numbering = createNumberingDefinitions(draft.meta.numbering);

  content.push(paragraph(title.toUpperCase(), "Title", { bold: true }));

  for (const block of draft.blocks) {
    appendBlock(content, block, {
      numberingProfile: draft.meta.numbering,
    });
  }

  const docxPackage: Document["package"] = {
    document: {
      content,
      finalSectionProperties: pageProperties(
        draft.meta.page.size,
        draft.meta.page.orientation,
      ),
    },
    styles: createStyleDefinitions(),
    properties: {
      title,
      creator: "Stella",
      created: new Date(),
      modified: new Date(),
    },
  };
  if (numbering) {
    docxPackage.numbering = numbering;
  }

  return {
    package: docxPackage,
  };
};

export type { Autofix, CompiledLegalDocument, LegalDraftDiagnostic };

type AppendBlockOptions = {
  numberingProfile: LegalNumberingProfile;
};

const appendBlock = (
  content: BlockContent[],
  block: LegalDraftBlock,
  options: AppendBlockOptions,
) => {
  switch (block.type) {
    case "title":
      return;
    case "recital":
      appendParagraphs(content, block.paragraphs, "Recital");
      return;
    case "clause": {
      content.push(
        paragraph(
          block.heading,
          clauseStyle(block.level),
          { bold: block.level === 1 },
          clauseNumbering(block, options.numberingProfile),
        ),
      );
      appendParagraphs(content, block.paragraphs, "BodyText");
      return;
    }
    case "paragraph":
      appendParagraphs(content, block.paragraphs, "BodyText");
      return;
    case "list":
      for (const item of block.items) {
        content.push(
          paragraph(
            item,
            "ListParagraph",
            {},
            listNumbering(block, options.numberingProfile),
          ),
        );
      }
      return;
    case "table":
      content.push(table(block.table.headers, block.table.rows));
      return;
    case "schedule":
      content.push(
        paragraph(
          block.heading,
          "ScheduleHeading",
          { bold: true },
          undefined,
          true,
        ),
      );
      appendParagraphs(content, block.paragraphs, "BodyText");
      return;
    case "signatures":
      content.push(signatureTable(block.parties));
      return;
    case "pageBreak":
      content.push({
        type: "paragraph",
        content: [
          {
            type: "run",
            content: [{ type: "break", breakType: "page" }],
          },
        ],
      });
      return;
    default:
      block satisfies never;
  }
};

const clauseNumbering = (
  block: Extract<LegalDraftBlock, { type: "clause" }>,
  profile: LegalNumberingProfile,
): { numId: number; ilvl: number } | undefined => {
  if (profile !== "legal") {
    return undefined;
  }
  return {
    numId: LEGAL_NUMBERING_ID,
    ilvl: Math.max(0, block.level - 1),
  };
};

const listNumbering = (
  block: Extract<LegalDraftBlock, { type: "list" }>,
  profile: LegalNumberingProfile,
): { numId: number; ilvl: number } | undefined => {
  if (profile === "none") {
    return undefined;
  }
  if (profile === "checklist") {
    return { numId: CHECKLIST_NUMBERING_ID, ilvl: 0 };
  }
  return {
    numId: block.ordered ? LEGAL_NUMBERING_ID : BULLET_NUMBERING_ID,
    ilvl: block.ordered ? 2 : 0,
  };
};

const appendParagraphs = (
  content: BlockContent[],
  paragraphs: string[],
  styleId: string,
) => {
  for (const text of paragraphs) {
    content.push(paragraph(text, styleId));
  }
};

type RunOptions = {
  bold?: boolean;
  italic?: boolean;
};

const paragraph = (
  text: string,
  styleId: string,
  runOptions: RunOptions = {},
  numPr?: { numId: number; ilvl: number },
  pageBreakBefore = false,
): Paragraph => ({
  type: "paragraph",
  formatting: {
    styleId,
    ...(numPr ? { numPr } : {}),
    ...(pageBreakBefore ? { pageBreakBefore: true } : {}),
  },
  content: textRunsWithPlaceholders(text, runOptions),
});

// Split text on `[[…]]` markers into a sequence of runs. Each
// placeholder becomes its own run with a yellow highlight so the
// reviewing lawyer sees at a glance everything still pending.
// Surrounding text inherits the run options (bold/italic) but not
// the highlight.
const PLACEHOLDER_PATTERN = /\[\[([^\][]+?)\]\]/g;

const textRunsWithPlaceholders = (
  text: string,
  options: RunOptions = {},
): Run[] => {
  if (!text.includes("[[")) {
    return [textRun(text, options)];
  }
  const runs: Run[] = [];
  let cursor = 0;
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const start = match.index;
    if (start > cursor) {
      runs.push(textRun(text.slice(cursor, start), options));
    }
    const inner = match[1] ?? "";
    runs.push(textRun(inner, options, { highlight: "yellow" }));
    cursor = start + match[0].length;
  }
  if (cursor < text.length) {
    runs.push(textRun(text.slice(cursor), options));
  }
  return runs.length > 0 ? runs : [textRun(text, options)];
};

const textRun = (
  text: string,
  options: RunOptions = {},
  extra: { highlight?: "yellow" } = {},
): Run => ({
  type: "run",
  formatting: {
    ...(options.bold ? { bold: true } : {}),
    ...(options.italic ? { italic: true } : {}),
    ...(extra.highlight ? { highlight: extra.highlight } : {}),
  },
  content: [{ type: "text", text, preserveSpace: true }],
});

const table = (headers: string[], rows: string[][]): Table => ({
  type: "table",
  rows: [tableRow(headers, true), ...rows.map((row) => tableRow(row, false))],
});

const tableRow = (cells: string[], header: boolean): TableRow => ({
  type: "tableRow",
  cells: cells.map((cell) => tableCell(cell, header)),
});

const tableCell = (text: string, header: boolean): TableCell => ({
  type: "tableCell",
  content: [paragraph(text, "TableText", { bold: header })],
});

// Side-by-side signature block: one column per party. Borderless
// so the columns read as distinct boxes without grid lines getting
// in the way. No language-specific captions — the column carries
// the bolded party name, a signing space, the `____` rule, and any
// `by:` / `title:` values the AI supplied (raw, in whatever language
// it wrote the document in).
const signatureTable = (
  parties: { name: string; signatory?: string; title?: string }[],
): Table => {
  const partyList =
    parties.length > 0 ? parties : [{ name: "", signatory: "", title: "" }];
  const empty = (): Paragraph => paragraph("", "SignatureSpacer");

  const buildCell = (party: {
    name: string;
    signatory?: string;
    title?: string;
  }): TableCell => {
    const cellContent: (Paragraph | Table)[] = [
      paragraph(party.name, "SignatureParty", { bold: true }),
      empty(),
      empty(),
      paragraph(SIGNATURE_LINE, "SignatureRule"),
    ];
    if (party.signatory) {
      cellContent.push(paragraph(party.signatory, "SignatureField"));
    }
    if (party.title) {
      cellContent.push(
        paragraph(party.title, "SignatureField", { italic: true }),
      );
    }
    return { type: "tableCell", content: cellContent };
  };

  return {
    type: "table",
    formatting: {
      borders: {
        top: { style: "none" },
        left: { style: "none" },
        bottom: { style: "none" },
        right: { style: "none" },
        insideH: { style: "none" },
        insideV: { style: "none" },
      },
    },
    rows: [{ type: "tableRow", cells: partyList.map(buildCell) }],
  };
};

const clauseStyle = (level: number): string => {
  if (level === 1) {
    return "ClauseHeading1";
  }
  if (level === 2) {
    return "ClauseHeading2";
  }
  return "ClauseHeading3";
};

const pageProperties = (
  size: LegalPageSize,
  orientation: LegalPageOrientation,
): SectionProperties => {
  const portrait =
    size === "A4"
      ? { pageWidth: 11_906, pageHeight: 16_838 }
      : { pageWidth: 12_240, pageHeight: 15_840 };
  const dimensions =
    orientation === "landscape"
      ? { pageWidth: portrait.pageHeight, pageHeight: portrait.pageWidth }
      : portrait;

  return {
    ...dimensions,
    orientation,
    marginTop: 1440,
    marginBottom: 1440,
    marginLeft: 1440,
    marginRight: 1440,
    headerDistance: 720,
    footerDistance: 720,
  };
};

const createStyleDefinitions = (): StyleDefinitions => ({
  docDefaults: {
    rPr: {
      fontFamily: {
        ascii: "Calibri",
        hAnsi: "Calibri",
        cs: "Calibri",
      },
      fontSize: 22,
    },
    pPr: {
      // ~1.15 line-height (240 = single, 276 ≈ 1.15)
      lineSpacing: 276,
      spaceAfter: 160,
    },
  },
  styles: [
    {
      styleId: "Normal",
      type: "paragraph",
      name: "Normal",
      default: true,
      rPr: {
        fontFamily: { ascii: "Calibri", hAnsi: "Calibri", cs: "Calibri" },
        fontSize: 22,
      },
    },
    {
      styleId: "Title",
      type: "paragraph",
      name: "Title",
      basedOn: "Normal",
      next: "BodyText",
      qFormat: true,
      // ALL CAPS title at 18pt (sz=36) reads as a legal cover
      // header without crowding the page.
      rPr: { bold: true, fontSize: 36, allCaps: true },
      pPr: { alignment: "center", spaceBefore: 240, spaceAfter: 480 },
    },
    {
      styleId: "BodyText",
      type: "paragraph",
      name: "Body Text",
      basedOn: "Normal",
      rPr: { fontSize: 22 },
      pPr: { alignment: "both", spaceAfter: 160 },
    },
    {
      styleId: "Recital",
      type: "paragraph",
      name: "Recital",
      basedOn: "BodyText",
      rPr: { italic: true },
    },
    {
      styleId: "ClauseHeading1",
      type: "paragraph",
      name: "Clause Heading 1",
      basedOn: "BodyText",
      next: "BodyText",
      qFormat: true,
      // Slightly larger + ALL CAPS for the top-level clause —
      // matches the visual hierarchy of the Title.
      rPr: { bold: true, fontSize: 24, allCaps: true },
      pPr: { keepNext: true, spaceBefore: 360, spaceAfter: 160 },
    },
    {
      styleId: "ClauseHeading2",
      type: "paragraph",
      name: "Clause Heading 2",
      basedOn: "BodyText",
      next: "BodyText",
      qFormat: true,
      rPr: { bold: true, fontSize: 22 },
      pPr: { keepNext: true, spaceBefore: 240, spaceAfter: 120 },
    },
    {
      styleId: "ClauseHeading3",
      type: "paragraph",
      name: "Clause Heading 3",
      basedOn: "BodyText",
      next: "BodyText",
      qFormat: true,
      rPr: { italic: true },
      pPr: { keepNext: true, spaceBefore: 160, spaceAfter: 120 },
    },
    {
      styleId: "ListParagraph",
      type: "paragraph",
      name: "List Paragraph",
      basedOn: "BodyText",
    },
    {
      styleId: "TableText",
      type: "paragraph",
      name: "Table Text",
      basedOn: "Normal",
      pPr: { spaceAfter: 0 },
    },
    {
      styleId: "ScheduleHeading",
      type: "paragraph",
      name: "Schedule Heading",
      basedOn: "ClauseHeading1",
      pPr: { pageBreakBefore: true, keepNext: true, spaceAfter: 240 },
    },
    // -- Signature block components -----------------------------------
    {
      styleId: "SignatureParty",
      type: "paragraph",
      name: "Signature Party",
      basedOn: "Normal",
      rPr: { bold: true, fontSize: 22 },
      pPr: { spaceBefore: 120, spaceAfter: 80 },
    },
    {
      styleId: "SignatureRule",
      type: "paragraph",
      name: "Signature Rule",
      basedOn: "Normal",
      // The rule is a string of underscores; clamp space so it sits
      // flush against the name/title below.
      pPr: { spaceBefore: 0, spaceAfter: 0 },
    },
    {
      styleId: "SignatureField",
      type: "paragraph",
      name: "Signature Field",
      basedOn: "Normal",
      rPr: { fontSize: 20 },
      pPr: { spaceAfter: 60 },
    },
    {
      styleId: "SignatureSpacer",
      type: "paragraph",
      name: "Signature Spacer",
      basedOn: "Normal",
      pPr: { spaceBefore: 0, spaceAfter: 80 },
    },
    // -- Footer -------------------------------------------------------
    {
      styleId: "Footer",
      type: "paragraph",
      name: "Footer",
      basedOn: "Normal",
      rPr: { fontSize: 18 },
      pPr: { alignment: "center", spaceAfter: 0 },
    },
  ],
});

const createNumberingDefinitions = (
  profile: LegalNumberingProfile,
): NumberingDefinitions | undefined => {
  if (profile === "none") {
    return undefined;
  }
  if (profile === "checklist") {
    return createChecklistNumberingDefinitions();
  }
  return createLegalNumberingDefinitions();
};

const createLegalNumberingDefinitions = (): NumberingDefinitions => ({
  abstractNums: [
    {
      abstractNumId: LEGAL_ABSTRACT_NUMBERING_ID,
      multiLevelType: "hybridMultilevel",
      levels: [
        {
          ilvl: 0,
          start: 1,
          numFmt: "decimal",
          lvlText: "%1.",
          suffix: "tab",
          isLgl: true,
          pPr: { indentLeft: 720, indentFirstLine: 720, hangingIndent: true },
          rPr: { bold: true },
        },
        {
          ilvl: 1,
          start: 1,
          numFmt: "decimal",
          lvlText: "%1.%2",
          suffix: "tab",
          isLgl: true,
          pPr: { indentLeft: 720, indentFirstLine: 720, hangingIndent: true },
        },
        {
          ilvl: 2,
          start: 1,
          numFmt: "lowerLetter",
          lvlText: "(%3)",
          suffix: "tab",
          pPr: { indentLeft: 1440, indentFirstLine: 720, hangingIndent: true },
        },
        {
          ilvl: 3,
          start: 1,
          numFmt: "lowerRoman",
          lvlText: "(%4)",
          suffix: "tab",
          pPr: { indentLeft: 1440, indentFirstLine: 720, hangingIndent: true },
        },
        {
          ilvl: 4,
          start: 1,
          numFmt: "upperLetter",
          lvlText: "(%5)",
          suffix: "tab",
          pPr: { indentLeft: 2160, indentFirstLine: 720, hangingIndent: true },
        },
      ],
    },
    {
      abstractNumId: BULLET_ABSTRACT_NUMBERING_ID,
      multiLevelType: "singleLevel",
      levels: [
        {
          ilvl: 0,
          start: 1,
          numFmt: "bullet",
          lvlText: "•",
          suffix: "tab",
          pPr: { indentLeft: 720, indentFirstLine: 360, hangingIndent: true },
        },
      ],
    },
  ],
  nums: [
    {
      numId: LEGAL_NUMBERING_ID,
      abstractNumId: LEGAL_ABSTRACT_NUMBERING_ID,
    },
    {
      numId: BULLET_NUMBERING_ID,
      abstractNumId: BULLET_ABSTRACT_NUMBERING_ID,
    },
  ],
});

const createChecklistNumberingDefinitions = (): NumberingDefinitions => ({
  abstractNums: [
    {
      abstractNumId: CHECKLIST_ABSTRACT_NUMBERING_ID,
      multiLevelType: "singleLevel",
      levels: [
        {
          ilvl: 0,
          start: 1,
          numFmt: "bullet",
          lvlText: "☐",
          suffix: "tab",
          pPr: { indentLeft: 720, indentFirstLine: 360, hangingIndent: true },
        },
      ],
    },
  ],
  nums: [
    {
      numId: CHECKLIST_NUMBERING_ID,
      abstractNumId: CHECKLIST_ABSTRACT_NUMBERING_ID,
    },
  ],
});
