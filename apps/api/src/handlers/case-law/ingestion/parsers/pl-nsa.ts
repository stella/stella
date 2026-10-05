/**
 * Polish administrative-court decision reader for the Hugging Face dataset
 * import.
 *
 * The dataset states each decision as up to four text columns, one per
 * section the court's own portal labels: the thesis (`Tezy`), the operative
 * part (`Sentencja`), the reasons (`Uzasadnienie`) and a dissenting opinion
 * (`Zdanie odrębne`). Paragraphs inside a column are separated by a blank
 * line. That is all the structure there is, and it is the publisher's, so the
 * document is built from it directly: a heading per present section, its
 * paragraphs under it with the role the section gives them. No wording is
 * matched to find a boundary (rule 9).
 */

import type {
  Block,
  DocumentAst,
  ParagraphRole,
} from "@/api/handlers/case-law/document-ast";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import {
  buildValidationHtml,
  validateAndLog,
  validateAst,
} from "@/api/lib/legal-search/parsers/validate-ast";
import type { ValidationResult } from "@/api/lib/legal-search/parsers/validate-ast";

/** Publisher recorded on the AST. */
const PL_NSA_SOURCE_SYSTEM = "orzeczenia.nsa.gov.pl";

/** The four text sections, in the order the court prints them. */
export const PL_NSA_TEXT_SECTIONS = [
  "thesis",
  "sentence",
  "reasons",
  "dissent",
] as const;

export type PlNsaTextSection = (typeof PL_NSA_TEXT_SECTIONS)[number];

type SectionShape = {
  /** The label the court's portal prints over the section. */
  readonly heading: string;
  readonly role: ParagraphRole;
  readonly type: DecisionSection["type"];
};

/**
 * What each section is. The thesis is the court's own statement of the point
 * of law, printed above the decision and not part of it, so its paragraphs
 * carry the `headnotes` role a reader may fold away.
 */
const SECTION_SHAPES = {
  thesis: { heading: "Tezy", role: "headnotes", type: "header" },
  sentence: { heading: "Sentencja", role: "holding", type: "ruling" },
  reasons: {
    heading: "Uzasadnienie",
    role: "argumentation",
    type: "argumentation",
  },
  dissent: { heading: "Zdanie odrębne", role: "dissent", type: "dissent" },
} as const satisfies Record<PlNsaTextSection, SectionShape>;

export const plNsaSectionHeading = (section: PlNsaTextSection): string =>
  SECTION_SHAPES[section].heading;

export type PlNsaSectionTexts = Readonly<
  Record<PlNsaTextSection, string | null>
>;

type ParsePlNsaDecisionInput = {
  caseNumber: string;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  /** The decision's title as the court's portal prints it. */
  title: string | undefined;
  documentId: string;
  sourceUrl: string;
  keywords: readonly string[];
  statutes: readonly string[];
  sections: PlNsaSectionTexts;
  /**
   * The dataset's own rendering of the whole decision (`full_text`), which
   * the document is checked against. Absent, the section columns are the
   * only statement of the text and the check reads them.
   */
  reference: string | null;
};

/**
 * Where the document's text was taken from: the four section columns, or —
 * where they lose text the dataset's full rendering carries, or are empty —
 * that rendering itself, as plain paragraphs (rule 10: never drop text).
 */
type PlNsaTextSource = "sections" | "full-text" | "none";

type ParsePlNsaDecisionOutput = {
  /** `null` when the row carries no text anywhere. */
  documentAst: DocumentAst | null;
  fulltext: string | undefined;
  sections: DecisionSection[];
  /** The completeness check of the document as returned; it always runs. */
  validation: ValidationResult;
  textSource: PlNsaTextSource;
};

/** Paragraphs of one section, as the dataset separates them. */
const plNsaParagraphs = (text: string): string[] =>
  text
    .replaceAll("\r\n", "\n")
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.replaceAll(" ", " ").trim())
    .filter((paragraph) => paragraph.length > 0);

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

type Built = { blocks: Block[]; sections: DecisionSection[] };

const fromSections = (sectionTexts: PlNsaSectionTexts): Built => {
  const blocks: Block[] = [];
  const sections: DecisionSection[] = [];
  for (const section of PL_NSA_TEXT_SECTIONS) {
    const text = sectionTexts[section];
    const paragraphs = text === null ? [] : plNsaParagraphs(text);
    if (paragraphs.length === 0) {
      continue;
    }
    const { heading, role, type } = SECTION_SHAPES[section];
    blocks.push({
      id: `b${blocks.length + 1}`,
      anchorId: `h-${section}`,
      type: "heading",
      level: 2,
      role: "section-heading",
      inlines: [{ type: "text", text: heading }],
      plainText: heading,
    });
    for (const [index, paragraph] of paragraphs.entries()) {
      blocks.push({
        id: `b${blocks.length + 1}`,
        anchorId: `p-${section}-${index + 1}`,
        type: "paragraph",
        role,
        inlines: [{ type: "text", text: paragraph }],
        plainText: paragraph,
      });
    }
    sections.push({
      index: sections.length,
      type,
      title: heading,
      text: paragraphs.join("\n\n"),
    });
  }
  return { blocks, sections };
};

/** The full rendering as plain paragraphs, in order, with no roles guessed. */
const fromReference = (paragraphs: readonly string[]): Built => ({
  blocks: paragraphs.map((paragraph, index) => ({
    id: `b${index + 1}`,
    anchorId: `p-${index + 1}`,
    type: "paragraph",
    inlines: [{ type: "text", text: paragraph }],
    plainText: paragraph,
  })),
  sections:
    paragraphs.length === 0
      ? []
      : [
          {
            index: 0,
            type: "unknown",
            title: null,
            text: paragraphs.join("\n\n"),
          },
        ],
});

export const parsePlNsaDecision = (
  input: ParsePlNsaDecisionInput,
): ParsePlNsaDecisionOutput => {
  const structured = fromSections(input.sections);
  // The reference is the dataset's own full rendering where it states one,
  // so text the sections do not carry reads as lost rather than passing a
  // check of the input against itself.
  const referenceParagraphs =
    input.reference === null
      ? structured.blocks.flatMap((block) =>
          block.type === "paragraph" ? [block.plainText] : [],
        )
      : plNsaParagraphs(input.reference);
  const referenceHtml = buildValidationHtml(
    referenceParagraphs.map(escapeHtml),
  );

  const sectionsHoldEverything =
    structured.blocks.length > 0 &&
    validateAst(referenceHtml, structured.blocks).ok;
  const fallBack = !sectionsHoldEverything && referenceParagraphs.length > 0;
  const chosen = fallBack ? fromReference(referenceParagraphs) : structured;
  let textSource: PlNsaTextSource = "none";
  if (fallBack) {
    textSource = "full-text";
  } else if (structured.blocks.length > 0) {
    textSource = "sections";
  }

  const blocks: Block[] =
    chosen.blocks.length > 0 && input.title !== undefined
      ? [
          {
            id: "b0",
            anchorId: "h-title",
            type: "heading",
            level: 1,
            role: "decision-title",
            inlines: [{ type: "text", text: input.title }],
            plainText: input.title,
          },
          ...chosen.blocks,
        ]
      : chosen.blocks;

  // Run on every path, the empty one included: a row that yields no text is
  // the case this signal exists to report.
  const validation = validateAndLog(
    {
      parser: "pl-nsa",
      caseNumber: input.caseNumber,
      language: "pl",
      url: input.sourceUrl,
    },
    referenceHtml,
    blocks,
  );

  if (blocks.length === 0) {
    return {
      documentAst: null,
      fulltext: undefined,
      sections: [],
      validation,
      textSource,
    };
  }

  return {
    documentAst: {
      version: 1,
      source: {
        system: PL_NSA_SOURCE_SYSTEM,
        documentId: input.documentId,
        webUrl: input.sourceUrl,
        printUrl: "",
      },
      metadata: {
        caseNumber: input.caseNumber,
        ecli: null,
        court: input.court,
        decisionDate: input.decisionDate ?? null,
        decisionType: input.decisionType ?? null,
        keywords: [...input.keywords],
        statutes: [...input.statutes],
      },
      blocks,
    },
    fulltext: blocks.map((block) => block.plainText).join("\n\n"),
    sections: chosen.sections,
    validation,
    textSource,
  };
};
