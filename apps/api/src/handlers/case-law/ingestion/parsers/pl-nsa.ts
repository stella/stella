/**
 * Polish administrative-court decision reader for the Hugging Face dataset
 * import.
 *
 * The dataset states each decision as up to four text columns, one per
 * section the court's own portal labels: the thesis (`Tezy`), the operative
 * part (`Sentencja`), the reasons (`Uzasadnienie`) and a dissenting opinion
 * (`Zdanie odrębne`). Paragraphs inside a column are separated by a blank
 * line, and so is every line the court's document broke, which is read back
 * below. That is all the structure there is, and it is the publisher's, so
 * the document is built from it directly: a heading per present section, its
 * paragraphs under it with the role the section gives them. No wording is
 * matched to find a boundary (rule 9).
 */

import { panic } from "better-result";

// parser-output-unchanged: imports the document AST from its package owner
import type {
  Block,
  DocumentAst,
  ParagraphRole,
} from "@stll/legal-ast/document-ast";

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
  /** The thesis as the document carries it, for the headnote; `null` absent. */
  thesis: string | null;
};

/** Paragraphs of one column, as the dataset separates them. */
const splitParagraphs = (text: string): string[] =>
  text
    .replaceAll("\r\n", "\n")
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.replaceAll(" ", " ").trim())
    .filter((paragraph) => paragraph.length > 0);

// ── Layout residue ───────────────────────────────────────
//
// The dataset turns every line break of the court's document into a
// paragraph break. Authors break lines by hand before a one-letter word,
// which Polish typesetting keeps off a line's end ("Kolegium decyzją" /
// "z dnia …"), and older documents break at the page margin, so a sentence
// reads as several paragraphs. After the rule that closes the document's
// body come its notes and page furniture: footnotes, running headers and
// page numbers. Only punctuation, letter case and the shape of a paragraph
// are read here; the one wording matched is the "Strona 2 z 9" a page
// number prints as.

/** The rule the court's document closes its body with. */
const CLOSING_RULE_RE = /^-{5,}$/u;

/** A page number, alone or as "page of pages": "2", "#/32", "Strona 2 z 9". */
const PAGE_NUMBER_RE =
  /^(?:\d{1,4}|#|[#\d]{0,4}\/\d{1,4}|[ivxl]{1,5}|[Ss]trona [#\d]{1,4} z \d{1,4})$/u;

/**
 * Page numbers after the closing rule, and the rule itself when nothing else
 * follows it. A footnote or a running header there stays.
 */
const withoutPageFurniture = (paragraphs: readonly string[]): string[] => {
  const rule = paragraphs.findLastIndex((paragraph) =>
    CLOSING_RULE_RE.test(paragraph),
  );
  if (rule === -1) {
    return [...paragraphs];
  }
  const notes = paragraphs
    .slice(rule + 1)
    .filter((paragraph) => !PAGE_NUMBER_RE.test(paragraph));
  return [
    ...paragraphs.slice(0, notes.length === 0 ? rule : rule + 1),
    ...notes,
  ];
};

/** Closing quotes and brackets that may follow a line's last punctuation. */
const CLOSERS = new Set(['"', "'", "”", "’", "»", ")", "]"]);

/** The line's last word, less the quotes and brackets closing it. */
const lastWordOf = (line: string): string => {
  let end = line.length;
  while (end > 0 && CLOSERS.has(line.charAt(end - 1))) {
    end -= 1;
  }
  return line.slice(line.lastIndexOf(" ", end - 1) + 1, end);
};

/** A colon, semicolon, question or exclamation mark ends the line's clause. */
const CLOSES_CLAUSE_RE = /[:;!?…]$/u;

/** A full stop ends the sentence, though not the dots of "[...]"… */
const CLOSES_SENTENCE_RE = /[^.]\.$/u;

/** …unless it closes an abbreviation: "r.", "zm.", "p.p.s.a.", "2021r.". */
const ABBREVIATION_RE = /^[([„"]?(?:\d*\p{L}{1,4}\.)+$/u;

/**
 * "a)", "c/", "ii)", "3)", "2b)", "3.2.7.", "4 -": the next item of a list,
 * not an abbreviation such as "m.in." or a date such as "30.12.1992".
 */
const LIST_ITEM_RE =
  /^(?:(?:\p{Ll}|[ivx]{2,4})[.)/](?!\p{L})|\d{1,3}(?:\.\d{1,3})*\p{Ll}?[.)/](?!\d)|\d{1,3} ?[-–] )/u;

/**
 * A page number, a bullet or a typist's initials ("ds", "a.bł.", "r p"):
 * a paragraph of its own, never part of a sentence.
 */
const NOT_PROSE_RE =
  /^(?:\d+|[^\p{L}\p{N}]+|(?:\p{Ll}{1,3}\.\s*|\p{Ll}{1,2}(?:\s+|$)){1,3})$/u;

/** How a paragraph continues into the next one. */
const PARAGRAPH_JOINS = {
  BREAK: "break",
  /** The line broke between two words. */
  SPACE: "space",
  /** The line broke after a hyphen, which stays: "rolno-" / "środowiskowe". */
  HYPHEN: "hyphen",
} as const;

type ParagraphJoin = (typeof PARAGRAPH_JOINS)[keyof typeof PARAGRAPH_JOINS];

/** How the line above a break continues into the line after it. */
const joinOf = (above: string, next: string): ParagraphJoin => {
  const lastWord = lastWordOf(above);
  if (
    CLOSING_RULE_RE.test(above) ||
    CLOSES_CLAUSE_RE.test(lastWord) ||
    (CLOSES_SENTENCE_RE.test(lastWord) && !ABBREVIATION_RE.test(lastWord)) ||
    LIST_ITEM_RE.test(next) ||
    NOT_PROSE_RE.test(above) ||
    NOT_PROSE_RE.test(next)
  ) {
    return PARAGRAPH_JOINS.BREAK;
  }
  if (/^\p{Ll}/u.test(next)) {
    return /\p{L}-$/u.test(above)
      ? PARAGRAPH_JOINS.HYPHEN
      : PARAGRAPH_JOINS.SPACE;
  }
  // A date or a figure the line broke before: "z dnia 14 lipca" / "2021 r.".
  return /^\d/u.test(next) && /[\p{Ll},]$/u.test(above)
    ? PARAGRAPH_JOINS.SPACE
    : PARAGRAPH_JOINS.BREAK;
};

/**
 * Paragraphs whose sentence the dataset broke, joined back into one. Each
 * join is read off the two lines either side of the break.
 */
const withSentencesJoined = (paragraphs: readonly string[]): string[] => {
  const [first, ...rest] = paragraphs;
  if (first === undefined) {
    return [];
  }
  const joined: string[] = [];
  let current = first;
  let above = first;
  for (const line of rest) {
    const join = joinOf(above, line);
    switch (join) {
      case PARAGRAPH_JOINS.BREAK:
        joined.push(current);
        current = line;
        break;
      case PARAGRAPH_JOINS.SPACE:
        current = `${current} ${line}`;
        break;
      case PARAGRAPH_JOINS.HYPHEN:
        current = `${current}${line}`;
        break;
      default: {
        join satisfies never;
        panic("Unhandled paragraph join");
      }
    }
    above = line;
  }
  joined.push(current);
  return joined;
};

// ── Superscript article numbers ──────────────────────────
//
// Article numbers such as 23¹ reach the dataset in several forms. Two keep a
// mark of the superscript: the digit set apart ("art. 23 ¹") and, in a
// document that also writes the article properly, a prime in its place
// ("art. 23'"). Both become the superscript the document itself uses. A
// superscript merged into the number ("art. 231") left no mark, and 231 is
// an article number in its own right, so it stays as published.

/** An article number, then a space before its superscript. */
const SPACED_SUPERSCRIPT_RE = /(\bart\.\s?\d+) (?=[⁰¹²³⁴⁵⁶⁷⁸⁹])/gu;

/** An article number and the superscript written on it: "art. 23¹". */
const ARTICLE_SUPERSCRIPT_RE = /\bart\.\s?(\d+)([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/gu;

/** A prime after an article number, not part of a word: "art. 23' §". */
const PRIMED_ARTICLE_RE = /(?<=\bart\.\s?)(\d+)['’`´](?![\p{L}\p{N}])/gu;

/** Article number to the one superscript the document writes it with. */
type PlNsaStatedSuperscripts = ReadonlyMap<string, string>;

/**
 * The superscript each article number carries where the document writes it
 * properly. A number written with two different superscripts names neither.
 */
export const plNsaStatedSuperscripts = (
  texts: readonly (string | null)[],
): PlNsaStatedSuperscripts => {
  const stated = new Map<string, Set<string>>();
  for (const text of texts) {
    for (const [, number, superscript] of (text ?? "")
      .replaceAll(SPACED_SUPERSCRIPT_RE, "$1")
      .matchAll(ARTICLE_SUPERSCRIPT_RE)) {
      if (number !== undefined && superscript !== undefined) {
        stated.set(number, (stated.get(number) ?? new Set()).add(superscript));
      }
    }
  }
  const unambiguous = new Map<string, string>();
  for (const [number, superscripts] of stated) {
    const [only, ...others] = superscripts;
    if (only !== undefined && others.length === 0) {
      unambiguous.set(number, only);
    }
  }
  return unambiguous;
};

const withSuperscripts = (
  paragraph: string,
  stated: PlNsaStatedSuperscripts,
): string =>
  paragraph
    .replaceAll(SPACED_SUPERSCRIPT_RE, "$1")
    .replaceAll(PRIMED_ARTICLE_RE, (primed, number: string) => {
      const superscript = stated.get(number);
      return superscript === undefined ? primed : `${number}${superscript}`;
    });

/**
 * Paragraphs of one column as the court wrote them: page furniture dropped,
 * broken sentences joined, the superscripts the dataset marked restored.
 */
export const plNsaParagraphs = (
  text: string,
  stated: PlNsaStatedSuperscripts,
): string[] =>
  withSentencesJoined(withoutPageFurniture(splitParagraphs(text))).map(
    (paragraph) => withSuperscripts(paragraph, stated),
  );

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

type Built = { blocks: Block[]; sections: DecisionSection[] };

const fromSections = (
  sectionTexts: PlNsaSectionTexts,
  stated: PlNsaStatedSuperscripts,
): Built => {
  const blocks: Block[] = [];
  const sections: DecisionSection[] = [];
  for (const section of PL_NSA_TEXT_SECTIONS) {
    const text = sectionTexts[section];
    const paragraphs = text === null ? [] : plNsaParagraphs(text, stated);
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
  const stated = plNsaStatedSuperscripts(
    input.reference === null
      ? PL_NSA_TEXT_SECTIONS.map((section) => input.sections[section])
      : [input.reference],
  );
  const structured = fromSections(input.sections, stated);
  const structuredParagraphs = structured.blocks.flatMap((block) =>
    block.type === "paragraph" ? [block.plainText] : [],
  );
  // The reference is the dataset's own full rendering where it states one,
  // so text the sections do not carry reads as lost rather than passing a
  // check of the input against itself. It is read as published, less only
  // its page numbers, so a word the reading drops shows as lost.
  const referenceParagraphs =
    input.reference === null
      ? structuredParagraphs
      : withoutPageFurniture(splitParagraphs(input.reference));
  const referenceHtml = buildValidationHtml(
    referenceParagraphs.map(escapeHtml),
  );

  const sectionsHoldEverything =
    structured.blocks.length > 0 &&
    validateAst(referenceHtml, structured.blocks).ok;
  const fallBack = !sectionsHoldEverything && referenceParagraphs.length > 0;
  const chosen = fallBack
    ? fromReference(
        input.reference === null
          ? structuredParagraphs
          : plNsaParagraphs(input.reference, stated),
      )
    : structured;
  const thesis =
    input.sections.thesis === null
      ? null
      : plNsaParagraphs(input.sections.thesis, stated).join("\n\n");
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
      thesis,
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
    thesis,
  };
};
