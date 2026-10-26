import { panic } from "better-result";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

import type {
  BlockContent as FolioBlockContent,
  Paragraph as FolioParagraph,
  ParagraphContent as FolioParagraphContent,
} from "@stll/docx-core/model";
/**
 * Czech Constitutional Court (Ustavni soud) HTML parser.
 *
 * Converts HTML from nalus.usoud.cz/Search/GetText.aspx
 * into a canonical DocumentAst.
 *
 * Primary source: the `docContentHidden` hidden field contains
 * RTF-encoded text with proper paragraph structure (`\par`
 * breaks, `\b`/`\b0` bold markers). This is far more reliable
 * than the visible `DocContent` HTML, which cramps everything
 * into a single run.
 *
 * Fallback: for pre-2007 decisions that lack the hidden field,
 * the old `extractLinesFromDocContent` approach is used.
 *
 * Decisions of the 1990s carry the court's typescript: one RTF
 * paragraph per printed line. Their lines are joined back into
 * paragraphs (`hard-wrapped-lines.ts`), and letter-spaced emphasis
 * ("N á v r h   s e   z a m í t á") is read as words.
 *
 * Additional hidden fields extracted for metadata:
 *   - `registrySignHidden` — e.g., "I.ÚS 100/25 #1"
 *   - `paralellQuotationHidden` — parallel citation
 *   - `popularNameHidden` — popular name
 *   - `docIdHidden` — numeric internal ID
 *   - `lblDecisionForm` — NÁLEZ/USNESENÍ
 *
 * Cross-reference `<a>` links in the DocContent HTML are
 * extracted for citation graph purposes.
 *
 * Structure:
 *   Ceska republika
 *   NALEZ / USNESENI
 *   Ustavniho soudu
 *   Jmenem republiky
 *
 *   Ustavni soud rozhodl v senatu slozenem z...
 *   ve veci ustavni stiznosti...
 *
 *   takto:
 *   I. ...  II. ...  (ruling items)
 *
 *   Oduvodneni:
 *   I. Section heading
 *   1. ...  2. ...  (numbered paragraphs)
 *
 *   V Brne dne ...
 *   Judge name + title
 */
import { caseLawSectionHeading } from "@stll/legal-ast/case-law-heading";
import { opensWithCourtParagraphMarker } from "@stll/legal-ast/court-paragraph-numbers";
import {
  CZ_CLOSING_RE as CLOSING_RE,
  CZ_JUDGE_NAME_RE as JUDGE_NAME_RE,
  CZ_JUDGE_TITLE_RE as SIGNATURE_RE,
} from "@stll/legal-ast/czech-document-roles";
// parser-output-unchanged: cached DocContent and direct paragraph validation preserve extracted content; the output retains its decision-specific AST type.
import {
  type Block,
  type DecisionDocumentAst,
  hasInlineChildren,
  type Inline,
  plainTextOf,
} from "@stll/legal-ast/document-ast";
import {
  normalizeInlineLine,
  stripInlineLinePrefix,
} from "@stll/legal-ast/inline-line";

import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { courtParagraphNumbers } from "@/api/lib/legal-search/parsers/court-paragraph-numbers";
import {
  type BodyDocumentLine,
  createParagraphLineReader,
  type DocumentLine,
} from "@/api/lib/legal-search/parsers/document-footnotes";
import {
  type ContinuingJoin,
  LINE_JOINS,
  printedLine,
  readHardWrap,
} from "@/api/lib/legal-search/parsers/hard-wrapped-lines";
import { collapseLetterSpacing } from "@/api/lib/legal-search/parsers/letter-spacing";
import { readRtfString } from "@/api/lib/legal-search/parsers/rtf-reader";
import { runContentVisibleText } from "@/api/lib/legal-search/parsers/run-content-text";
import { validateAndLog } from "@/api/lib/legal-search/parsers/validate-ast";
import { RTF_SOURCE_OPTIONS } from "@/api/lib/legal-search/rtf-source-registry";
import { segmentDecisionBlocks } from "@/api/lib/legal-search/segment-decision";

import { stripFurniturePrefix, visibleHtmlText } from "./shared-inlines";

// ── Public API ─────────────────────────────────────────────

export type ParseUsDecisionInput = {
  html: string;
  caseNumber: string;
  ecli: string | undefined;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
};

type CrossReference = {
  caseNumber: string;
  href: string;
};

type ParseUsDecisionOutput = {
  documentAst: DecisionDocumentAst;
  fulltext: string;
  sections: DecisionSection[];
  /** Cross-references to other decisions found in the HTML. */
  crossReferences: CrossReference[];
};

export const parseUsDecisionHtml = (
  input: ParseUsDecisionInput,
): ParseUsDecisionOutput => {
  const $ = cheerio.load(input.html);
  const docContent = $(".DocContent");

  // Extract metadata from hidden fields
  const hiddenMeta = extractHiddenMetadata($);

  // Extract cross-reference links from the visible HTML
  const crossReferences = extractCrossReferences($, docContent);

  const lines = extractLines($, docContent);
  const blocks = courtParagraphNumbers(classifyUsDocumentLines(lines), {
    parser: "cz-us",
    caseNumber: input.caseNumber,
  });

  // Synthesize decision title heading if none was parsed.
  // The RTF docContentHidden doesn't include decorative
  // headers; the decision form lives in lblDecisionForm.
  const hasTitle = blocks.some(
    (b) => b.type === "heading" && b.role === "decision-title",
  );
  if (!hasTitle && hiddenMeta.decisionForm) {
    blocks.unshift({
      id: `b0`,
      anchorId: "h-title",
      type: "heading",
      level: 1,
      role: "decision-title",
      inlines: [{ type: "text", text: hiddenMeta.decisionForm }],
      plainText: hiddenMeta.decisionForm,
    });
  }

  // Build validation HTML from extracted lines instead of
  // passing the raw page HTML. The page HTML concatenates
  // all text without whitespace between sections, creating
  // phantom words like "tarifu.ii.skutkové" that aren't in
  // the AST. Using per-line <p> tags preserves word boundaries.
  const validationParagraphs = lines.map((line) =>
    line.kind === "body" ? line.value.plainText : line.note.value.plainText,
  );
  validateAndLog(
    { parser: "cz-us", caseNumber: input.caseNumber },
    { type: "paragraphs", paragraphs: validationParagraphs },
    blocks,
  );

  const fulltext = blocks
    .flatMap((b) => (b.plainText ? [b.plainText] : []))
    .join("\n\n");

  const ast: DecisionDocumentAst = {
    version: 1,
    source: {
      system: "nalus.usoud.cz",
      documentId: hiddenMeta.docId ?? input.caseNumber,
      webUrl: "",
      printUrl: "",
    },
    metadata: {
      caseNumber: input.caseNumber,
      ecli: input.ecli ?? null,
      court: input.court,
      decisionDate: input.decisionDate ?? null,
      decisionType: hiddenMeta.decisionForm ?? input.decisionType ?? null,
      keywords: [],
      statutes: [],
    },
    blocks,
  };

  return {
    documentAst: ast,
    fulltext,
    sections: segmentDecisionBlocks(blocks),
    crossReferences,
  };
};

// ── Hidden-field metadata ─────────────────────────────────

type HiddenMetadata = {
  registrySign: string | null;
  parallelQuotation: string | null;
  popularName: string | null;
  docId: string | null;
  decisionForm: string | null;
};

const extractHiddenMetadata = ($: cheerio.CheerioAPI): HiddenMetadata => ({
  registrySign: $("input#registrySignHidden").attr("value") ?? null,
  parallelQuotation: $("input#paralellQuotationHidden").attr("value") ?? null,
  popularName: $("input#popularNameHidden").attr("value") ?? null,
  docId: $("input#docIdHidden").attr("value") ?? null,
  decisionForm: visibleHtmlText($("span#lblDecisionForm")).trim() || null,
});

// ── Cross-reference extraction ────────────────────────────

const CROSS_REF_HREF_RE = /GetRegSignDecisions\.aspx\?sz=/iu;

/**
 * Extract cross-reference links to other ÚS decisions from
 * the visible DocContent HTML.
 */
const extractCrossReferences = (
  $: cheerio.CheerioAPI,
  docContent: cheerio.Cheerio<AnyNode>,
): CrossReference[] => {
  const refs: CrossReference[] = [];
  const seen = new Set<string>();

  docContent.find("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!CROSS_REF_HREF_RE.test(href)) {
      return;
    }

    const text = visibleHtmlText($(el)).trim();
    if (!text || seen.has(text)) {
      return;
    }

    seen.add(text);
    refs.push({ caseNumber: text, href });
  });

  return refs;
};

/** Create a simple text inline helper. */
const textInline = (text: string): Inline[] => [{ type: "text", text }];

type ParsedLineData = ReturnType<typeof normalizeInlineLine>;
type ParsedLine = DocumentLine<ParsedLineData>;

// ── RTF reading ───────────────────────────────────────────

const rtfInlinesOf = (paragraph: FolioParagraph): Inline[] => {
  const inlines: Inline[] = [];

  const visit = (items: readonly FolioParagraphContent[]): void => {
    for (const item of items) {
      switch (item.type) {
        case "run": {
          const text = item.content.map(runContentVisibleText).join("");
          if (text.length === 0) {
            break;
          }
          const inline: Inline = { type: "text", text };
          inlines.push(
            item.formatting?.bold === true
              ? { type: "bold", children: [inline] }
              : inline,
          );
          break;
        }
        case "hyperlink":
        case "simpleField":
        case "inlineSdt":
        case "inlineWrapper":
        case "insertion":
        case "moveTo":
          visit(item.type === "hyperlink" ? item.children : item.content);
          break;
        case "complexField":
          for (const run of item.fieldResult) {
            visit([run]);
          }
          break;
        case "mathEquation":
          if (item.plainText) {
            inlines.push({ type: "text", text: item.plainText });
          }
          break;
        case "preservedInline":
          if (item.text) {
            inlines.push({ type: "text", text: item.text });
          }
          break;
        case "deletion":
        case "moveFrom":
        case "bookmarkStart":
        case "bookmarkEnd":
        case "moveFromRangeStart":
        case "moveFromRangeEnd":
        case "moveToRangeStart":
        case "moveToRangeEnd":
        case "commentRangeStart":
        case "commentRangeEnd":
        case "commentReference":
          break;
        default:
          item satisfies never;
          panic("Unhandled RTF paragraph content");
      }
    }
  };

  visit(paragraph.content);
  return coalesceRuns(inlines);
};

/**
 * Adjacent runs of the same formatting as one inline. RTF starts a run at
 * every escaped character (`N \'e1 v r h`), and a word read run by run
 * cannot be recognised as letter-spaced or as a heading.
 */
const coalesceRuns = (inlines: readonly Inline[]): Inline[] => {
  const result: Inline[] = [];
  for (const node of inlines) {
    const previous = result.at(-1);
    if (previous?.type === "text" && node.type === "text") {
      result[result.length - 1] = {
        ...previous,
        text: previous.text + node.text,
      };
      continue;
    }
    if (previous?.type === "bold" && node.type === "bold") {
      result[result.length - 1] = {
        ...previous,
        children: coalesceRuns([...previous.children, ...node.children]),
      };
      continue;
    }
    result.push(node);
  }
  return result;
};

/** Primary extraction: read the `docContentHidden` RTF field. */
const extractLinesFromRtf = (rtfContent: string): ParsedLine[] => {
  const document = readRtfString(
    rtfContent,
    RTF_SOURCE_OPTIONS[ADAPTER_KEYS.CZ_US],
  );
  return usDocumentLinesOf(document);
};

/** A line as the RTF printed it, and which run of adjacent paragraphs it is in. */
type PrintedUsLine = {
  readonly line: DocumentLine<Inline[]>;
  /**
   * Paragraphs side by side in one container. A table cell is a run of its
   * own, and so is the text after a table: a printed line never continues
   * across either.
   */
  readonly run: number;
};

type UsDocumentLinesOptions = {
  /**
   * Trims a line's inlines. Each printed line is trimmed once and each
   * paragraph once more; a test counts the work through it.
   */
  normalize?: typeof normalizeInlineLine;
};

/** Shared-model entry point, including nested tables and content controls. */
export const usDocumentLinesOf = (
  document: ReturnType<typeof readRtfString>,
  { normalize = normalizeInlineLine }: UsDocumentLinesOptions = {},
): ParsedLine[] => {
  const printed: PrintedUsLine[] = [];
  let run = 0;
  const readLines = createParagraphLineReader(document, rtfInlinesOf);
  const visit = (blocks: readonly FolioBlockContent[]): void => {
    for (const block of blocks) {
      switch (block.type) {
        case "paragraph":
          for (const line of readLines(block)) {
            printed.push({ line, run });
          }
          break;
        case "table":
          for (const row of block.rows) {
            for (const cell of row.cells) {
              run += 1;
              visit(cell.content);
            }
          }
          run += 1;
          break;
        case "blockSdt":
        case "blockCustomXml":
          visit(block.content);
          break;
        case "preservedBlock":
        case "bookmarkStart":
        case "bookmarkEnd":
          break;
        default:
          block satisfies never;
          panic("Unhandled CZ document block");
      }
    }
  };
  visit(document.package.document.content);
  return reflowUsLines(printed, normalize);
};

const mapInlineText = (
  inlines: readonly Inline[],
  map: (text: string) => string,
): Inline[] =>
  inlines.map((node): Inline => {
    if (node.type === "text") {
      return { ...node, text: map(node.text) };
    }
    return hasInlineChildren(node)
      ? { ...node, children: mapInlineText(node.children, map) }
      : node;
  });

/**
 * Drop the last character of the inlines, wherever it is nested. Touches
 * only the trailing node, so it costs the same however long the paragraph.
 */
const dropLastCharacter = (inlines: Inline[]): void => {
  for (let index = inlines.length - 1; index >= 0; index -= 1) {
    const node = inlines[index];
    if (node === undefined || plainTextOf([node]).length === 0) {
      continue;
    }
    if (node.type === "text") {
      inlines[index] = { ...node, text: node.text.slice(0, -1) };
      return;
    }
    if (hasInlineChildren(node)) {
      const children = [...node.children];
      dropLastCharacter(children);
      inlines[index] = { ...node, children };
      return;
    }
    // A line break: one character on the text axis, and the last one.
    inlines.splice(index, 1);
    return;
  }
};

/**
 * Append the next printed line, already trimmed, to a paragraph whose lines
 * were trimmed as they came, as the margin joined them.
 */
const appendPrintedLine = (
  paragraph: Inline[],
  line: readonly Inline[],
  join: ContinuingJoin,
): void => {
  switch (join) {
    case LINE_JOINS.SPACE:
      paragraph.push({ type: "text", text: " " }, ...line);
      return;
    case LINE_JOINS.WORD:
      dropLastCharacter(paragraph);
      paragraph.push(...line);
      return;
    case LINE_JOINS.COMPOUND:
      paragraph.push(...line);
      return;
    default:
      join satisfies never;
      panic("Unhandled printed line join");
  }
};

/**
 * The printed lines as the court's paragraphs: letter-spaced words read as
 * words, and a typescript's margin-wrapped lines joined back together. See
 * `hard-wrapped-lines.ts` for when a document counts as one.
 *
 * Each line is trimmed once as it joins and each paragraph once when it
 * closes, so the work grows with the text, not with a paragraph's length
 * times its lines.
 */
const reflowUsLines = (
  printed: readonly PrintedUsLine[],
  normalize: typeof normalizeInlineLine,
): ParsedLine[] => {
  const reading = readHardWrap(
    printed.map(({ line }) =>
      line.kind === "body" ? printedLine(plainTextOf(line.value)) : null,
    ),
  );
  // Not a typescript: every line is its own paragraph, and an absent join
  // below reads as a break.
  const joins =
    reading === null
      ? []
      : reading.joins.map((join, index) =>
          printed[index]?.run === printed[index + 1]?.run
            ? join
            : LINE_JOINS.BREAK,
        );
  const finish = (inlines: readonly Inline[]): ParsedLineData =>
    normalize(
      reading === null ? inlines : mapInlineText(inlines, reading.clean),
    );
  const spelled = (inlines: readonly Inline[]): Inline[] =>
    mapInlineText(inlines, collapseLetterSpacing);

  const lines: ParsedLine[] = [];
  let paragraph: Inline[] | null = null;
  for (const [index, { line }] of printed.entries()) {
    if (line.kind === "note") {
      lines.push({
        kind: "note",
        note: { ...line.note, value: finish(spelled(line.note.value)) },
      });
      continue;
    }
    const continues = (joins[index] ?? LINE_JOINS.BREAK) !== LINE_JOINS.BREAK;
    const join = joins[index - 1] ?? LINE_JOINS.BREAK;
    if (paragraph === null || join === LINE_JOINS.BREAK) {
      // A paragraph of one line is trimmed when it closes.
      paragraph = continues
        ? [...normalize(spelled(line.value)).inlines]
        : spelled(line.value);
    } else {
      appendPrintedLine(
        paragraph,
        normalize(spelled(line.value)).inlines,
        join,
      );
    }
    if (!continues) {
      lines.push({ kind: "body", value: finish(paragraph) });
      paragraph = null;
    }
  }
  return lines;
};

/**
 * Fallback extraction from the visible DocContent HTML.
 *
 * Used for pre-2007 decisions that may not have the
 * `docContentHidden` field. Splits the crammed text at
 * paragraph boundaries using heuristics.
 */
const extractLinesFromDocContent = (
  $: cheerio.CheerioAPI,
  docContent: cheerio.Cheerio<AnyNode>,
): ParsedLine[] => {
  const container = docContent.length > 0 ? docContent : $("body");

  const fullText = visibleHtmlText(container).trim();
  if (!fullText) {
    return [];
  }

  const parts = splitAtParagraphBoundaries(fullText);
  const lines: ParsedLine[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    lines.push({
      kind: "body",
      value: normalizeInlineLine(textInline(trimmed)),
    });
  }

  return lines;
};

/**
 * Split a long text block at embedded paragraph boundaries.
 *
 * ÚS decisions often have all paragraphs crammed into one
 * continuous string like "...stěžovatele.5.  Ústavní soud..."
 * This splits at:
 *   - Numbered paragraphs: ".N. " or ".N.  " (after sentence end)
 *   - Section markers: "Odůvodnění:", "Poučení:"
 *   - Closing: "V Brně dne"
 */
const splitAtParagraphBoundaries = (text: string): string[] => {
  let parts = [text];
  for (const boundary of PARAGRAPH_BOUNDARY_PATTERNS) {
    parts = parts.flatMap((part) => part.split(boundary));
  }
  return parts;
};

const PARAGRAPH_BOUNDARY_PATTERNS = [
  /(?<=\.)(?=\d{1,3}\.\s)/u,
  /(?=Odůvodnění\s*:)/u,
  /(?=Poučení\s*:)/u,
  /(?=V\s+\p{Lu}\p{Ll}+\s+(?:dne\s+)?\d)/u,
] as const;

/**
 * Extract lines from the HTML page.
 *
 * Prefers the `docContentHidden` RTF field; falls back to
 * parsing the visible DocContent HTML.
 */
const extractLines = (
  $: cheerio.CheerioAPI,
  docContent: cheerio.Cheerio<AnyNode>,
): ParsedLine[] => {
  const rtfContent = $("input#docContentHidden").attr("value") ?? "";

  if (rtfContent.trim()) {
    return extractLinesFromRtf(rtfContent);
  }

  // Fallback: parse the visible DocContent HTML
  return extractLinesFromDocContent($, docContent);
};

// ── Patterns ───────────────────────────────────────────────

/**
 * Image placeholders for the court emblem, which the export glues to the
 * start of whatever line follows them rather than setting on their own.
 */
const EMBLEM_PREFIX_RE = /^(?:\[OBRÁZEK\]\s*)*/u;

/** Decorative lines carrying no content once the emblem is peeled. */
const DECORATIVE_LINE_RE = /^(?:Česká republika|ČESKÁ REPUBLIKA)$/u;

/** Decision title (level 1). */
const TITLE_RE =
  /^(?:N\s*[ÁA]\s*L\s*[ÉE]\s*Z|U\s*S\s*N\s*E\s*S\s*E\s*N\s*[ÍI]|Ústavního soudu|Jménem republiky)$/iu;

/** Normalize spaced text like "t a k t o" -> "takto". */
const collapseSpaces = (text: string): string =>
  text.replace(/(?<keep>\S)\s+(?=\S)/gu, "$<keep>");

/** "takto:" separator (with spaced variants). */
const TAKTO_RE = /^t\s*a\s*k\s*t\s*o\s*(?::\s*)?$/iu;

/**
 * The opening sentence of a decision ending in "takto:". Since the court
 * stopped setting the word on a line of its own, the ruling follows the
 * sentence that names the parties directly.
 */
const TAKTO_TAIL_RE = /(?:^|[\s,])takto\s*:$/u;

/** "Odůvodnění:" separator (with spaced variants). */
const ODUVODNENI_RE =
  /^(?:O\s*d\s*[uů]\s*v\s*o\s*d\s*n\s*[eě]\s*n\s*[ií]|Odůvodnění)\s*(?::\s*)?$/iu;

/**
 * Section heading in Odůvodnění: standalone Roman numeral,
 * or Roman numeral followed by a short title on the same or
 * next line.
 */
const SECTION_ROMAN_RE = /^(?=[IVX])(?<roman>X{0,3}(?:IX|IV|V?I{0,3}))\.?\s*$/u;

/** Numbered paragraph: "1. ...", "2. ..." */
const NUMBERED_PARA_RE = /^(?:\d+)\.\s+/u;

/** The court's first reasoning paragraph, which no ruling item opens with. */
const FIRST_REASONING_PARAGRAPH_RE = /^(?:\[1\]|1\.)\s/u;

/**
 * A line a section title never is: one opening with a list item, or ending
 * where a sentence or a printed line goes on. A title may end with a full
 * stop ("… zákona č. 128/1946 Sb."); a long line that does is a sentence.
 */
const ITEM_OPENING_RE = /^(?:\d{1,3}[.)]|\p{L}\)|[-–•])\s/u;
const UNFINISHED_TITLE_RE = /[,;:-]$/u;
const TITLE_SENTENCE_MAX_WORDS = 10;

const readsAsSentence = (text: string): boolean =>
  UNFINISHED_TITLE_RE.test(text) ||
  (text.endsWith(".") && text.split(/\s+/u).length > TITLE_SENTENCE_MAX_WORDS);

/**
 * Heading opening a separate opinion. The court prints it either on its own
 * or as the next enumerated item, and names the dissenting judges after it,
 * so the pattern is anchored at the start and bounded by length rather than
 * closed at the end.
 */
const DISSENT_HEADING_RE =
  /^(?:Odli[šs]n[ée]\s+stanovisko|Odli[šs]n[áa]\s+stanoviska|Stanovisko\s+men[šs]iny)(?<tail>.*)$/iu;
/**
 * The early plenary set its opinions under a bare, letter-spaced
 * "S T A N O V I S K O" and named the judges on the following lines.
 */
const BARE_OPINION_HEADING_RE = /^STANOVISKO(?<tail>)$/u;
/**
 * What the heading line goes on with: nothing, or whose opinion it is and
 * what it is to. "Odlišné stanovisko odůvodňuji takto:" is a sentence of the
 * opinion, not its heading.
 */
const DISSENT_HEADING_TAIL_RE =
  /^(?:\s*[.:]?$|\s+(?:(?:k|ke|ve|podle)\s|soud|předsed|místopředsed|JUDr|prof|doc|Mgr|pléna|člen|men[šs]in|podan|uplatn|vyjádřen))/iu;
/** A heading line that names its author. */
const NAMES_AUTHOR_RE = /(?:^|\s)(?:soudc|soudky|soudkyň|JUDr)/iu;
/** The judges named on the lines after a bare heading. */
const AUTHOR_CONTINUATION_RE = /^(?:soudc|soudky|soudkyň)/iu;
const DISSENT_HEADING_MAX_CHARS = 120;
/**
 * A closing names the place and the date and nothing else. A paragraph that
 * opens with a date ("Dne 26. 8. 1993 zaslaly stěžovatelky …") is reasoning.
 */
const CLOSING_MAX_CHARS = 80;
/** Longest heading an author continuation can make. */
const DISSENT_TITLE_MAX_CHARS = 500;

// ── Block classification ───────────────────────────────────

const makeAnchorId = (prefix: string, index: number): string =>
  `${prefix}-${index}`;

/**
 * Strip a character-counted prefix from inlines.
 */
/**
 * Classify extracted lines into semantic blocks.
 *
 * Tracks parser state across three zones:
 *   1. Preamble (before "takto:")
 *   2. Výrok / ruling zone (between "takto:" and "Odůvodnění:")
 *   3. Odůvodnění zone (after "Odůvodnění:")
 */
type UsClassificationState = {
  blockCounter: number;
  blockIndex: number;
  inRuling: boolean;
  inOduvodneni: boolean;
  inDissent: boolean;
  /** Whether the ruling zone has produced a holding yet. */
  sawHolding: boolean;
  consumedLines: Set<ParsedLine>;
};

const makeUsBlockId = (state: UsClassificationState): string => {
  state.blockCounter += 1;
  return `b${state.blockCounter}`;
};

type ClassifyUsBodyLineOptions = {
  body: BodyDocumentLine<ParsedLineData>;
  i: number;
  lines: readonly ParsedLine[];
  blocks: Block[];
  state: UsClassificationState;
};

const classifyUsBodyLine = ({
  body,
  i,
  lines,
  blocks,
  state,
}: ClassifyUsBodyLineOptions): void => {
  const line = body.value;
  // Skip empty sentinel lines (paragraph breaks)
  if (!line.plainText) {
    return;
  }

  // Peel the emblem rather than dropping the line it is glued to, then skip
  // what turns out to have been decoration and nothing else.
  const normalized = normalizeInlineLine(
    stripFurniturePrefix(line.inlines, EMBLEM_PREFIX_RE),
  );
  const { inlines, plainText } = normalized;
  if (!plainText || DECORATIVE_LINE_RE.test(plainText)) {
    return;
  }

  // Decision title: NALEZ, USNESENI, etc.
  const collapsed = collapseSpaces(plainText);
  if (TITLE_RE.test(plainText) || TITLE_RE.test(collapsed)) {
    state.blockIndex += 1;
    blocks.push({
      id: makeUsBlockId(state),
      anchorId: makeAnchorId("h", state.blockIndex),
      type: "heading",
      level: 1,
      role: "decision-title",
      inlines,
      plainText,
    });
    return;
  }

  // "takto:" separator
  if (TAKTO_RE.test(plainText) || TAKTO_RE.test(collapsed)) {
    state.inRuling = true;
    state.blockIndex += 1;
    blocks.push({
      id: makeUsBlockId(state),
      anchorId: makeAnchorId("h", state.blockIndex),
      type: "heading",
      level: 2,
      role: "section-heading",
      inlines: textInline("takto:"),
      plainText: "takto:",
    });
    return;
  }

  // "Odůvodnění:" separator
  if (ODUVODNENI_RE.test(plainText) || ODUVODNENI_RE.test(collapsed)) {
    state.inRuling = false;
    state.inOduvodneni = true;
    state.blockIndex += 1;
    blocks.push({
      id: makeUsBlockId(state),
      anchorId: makeAnchorId("h", state.blockIndex),
      type: "heading",
      level: 2,
      role: "section-heading",
      inlines: textInline("Odůvodnění:"),
      plainText: "Odůvodnění:",
    });
    return;
  }

  // A separate opinion runs to the end of the document, so the heading
  // opens a zone rather than a section.
  const dissentTail = opinionHeadingTail(normalized);
  if (dissentTail !== undefined) {
    state.inDissent = true;
    state.blockIndex += 1;
    blocks.push({
      id: makeUsBlockId(state),
      anchorId: makeAnchorId("h", state.blockIndex),
      type: "heading",
      level: 2,
      role: "section-heading",
      ...(NAMES_AUTHOR_RE.test(dissentTail)
        ? { inlines, plainText }
        : withAuthorContinuation({ heading: normalized, i, lines, state })),
    });
    return;
  }

  // A line the court numbered ("3. Věc projednal senát …") is body text,
  // never a closing or a signature, however it reads: classifying it away
  // would leave a gap in the court's numbering.
  const courtNumbered = opensWithCourtParagraphMarker(plainText);

  // Closing: "V Brně dne ..."
  if (
    !courtNumbered &&
    plainText.length <= CLOSING_MAX_CHARS &&
    CLOSING_RE.test(plainText)
  ) {
    state.blockIndex += 1;
    blocks.push({
      id: makeUsBlockId(state),
      anchorId: makeAnchorId("p", state.blockIndex),
      type: "paragraph",
      role: "closing",
      inlines,
      plainText,
    });
    return;
  }

  // Signature: judge title line
  if (!courtNumbered && SIGNATURE_RE.test(plainText) && plainText.length < 80) {
    state.blockIndex += 1;
    blocks.push({
      id: makeUsBlockId(state),
      anchorId: makeAnchorId("p", state.blockIndex),
      type: "paragraph",
      role: "signature",
      inlines,
      plainText,
    });
    return;
  }

  // Judge name line (short, academic title prefix;
  // only at the tail of the document)
  if (
    JUDGE_NAME_RE.test(plainText) &&
    plainText.length < 80 &&
    !state.inRuling
  ) {
    // Look ahead: if the next non-empty line is a
    // signature or another judge name, treat as signature.
    const nextNonEmpty = findNextNonEmpty(lines, i + 1);
    if (
      !nextNonEmpty ||
      SIGNATURE_RE.test(nextNonEmpty.value.plainText) ||
      JUDGE_NAME_RE.test(nextNonEmpty.value.plainText) ||
      CLOSING_RE.test(nextNonEmpty.value.plainText)
    ) {
      state.blockIndex += 1;
      blocks.push({
        id: makeUsBlockId(state),
        anchorId: makeAnchorId("p", state.blockIndex),
        type: "paragraph",
        role: "signature",
        inlines,
        plainText,
      });
      return;
    }
  }

  if (closesRuling(state, plainText)) {
    state.inRuling = false;
    state.inOduvodneni = true;
  }

  // Ruling items (in the ruling zone): detected by Roman
  // numeral prefix, emitted as holding paragraphs with
  // the full original text preserved.
  if (state.inRuling && !state.inOduvodneni) {
    state.sawHolding = true;
    state.blockIndex += 1;
    blocks.push({
      id: makeUsBlockId(state),
      anchorId: makeAnchorId("p", state.blockIndex),
      type: "paragraph",
      role: "holding",
      inlines,
      plainText,
    });
    return;
  }

  // Section headings in Odůvodnění: standalone Roman
  // numeral possibly followed by a title on the next line
  if (state.inOduvodneni) {
    const titledRoman = caseLawSectionHeading(plainText);
    if (titledRoman !== null && readsAsSectionTitle(plainText)) {
      state.blockIndex += 1;
      blocks.push({
        id: makeUsBlockId(state),
        anchorId: makeAnchorId("h", state.blockIndex),
        type: "heading",
        level: titledRoman.level,
        inlines,
        plainText,
      });
      return;
    }

    const romanMatch = SECTION_ROMAN_RE.exec(plainText);
    if (romanMatch) {
      // Check if next non-empty line is a short title
      const nextNonEmpty = findNextNonEmpty(lines, i + 1);
      if (
        nextNonEmpty &&
        nextNonEmpty.value.plainText.length < 120 &&
        !ITEM_OPENING_RE.test(nextNonEmpty.value.plainText) &&
        !readsAsSentence(nextNonEmpty.value.plainText) &&
        !SECTION_ROMAN_RE.test(nextNonEmpty.value.plainText) &&
        !CLOSING_RE.test(nextNonEmpty.value.plainText)
      ) {
        // Combine Roman numeral + title line
        const combinedText = `${romanMatch.groups?.["roman"] ?? ""}. ${nextNonEmpty.value.plainText}`;
        state.blockIndex += 1;
        blocks.push({
          id: makeUsBlockId(state),
          anchorId: makeAnchorId("h", state.blockIndex),
          type: "heading",
          level: 3,
          inlines: textInline(combinedText),
          plainText: combinedText,
        });
        // Skip the consumed title line
        state.consumedLines.add(nextNonEmpty);
        return;
      }

      // Standalone Roman numeral heading
      const headingText = `${romanMatch[1] ?? ""}.`;
      state.blockIndex += 1;
      blocks.push({
        id: makeUsBlockId(state),
        anchorId: makeAnchorId("h", state.blockIndex),
        type: "heading",
        level: 3,
        inlines: textInline(headingText),
        plainText: headingText,
      });
      return;
    }
  }

  // Default: paragraph. A numbered one ("1. …") stays whole here: whether
  // its marker is the court's numbering is decided over the whole decision,
  // by `courtParagraphNumbers` once every block is classified.
  state.blockIndex += 1;
  blocks.push({
    id: makeUsBlockId(state),
    anchorId: makeAnchorId("p", state.blockIndex),
    type: "paragraph",
    role: state.inDissent ? "dissent" : undefined,
    inlines,
    plainText,
  });
  state.inRuling ||= opensRuling(state, plainText);
};

/**
 * Reasoning the court did not head with "Odůvodnění": its first numbered
 * paragraph, after the holdings, closes the ruling.
 */
const closesRuling = (
  state: UsClassificationState,
  plainText: string,
): boolean =>
  state.inRuling &&
  state.sawHolding &&
  FIRST_REASONING_PARAGRAPH_RE.test(plainText);

/** The opening sentence ends in "takto:", and the ruling follows it. */
const opensRuling = (
  state: UsClassificationState,
  plainText: string,
): boolean =>
  !state.inOduvodneni && !state.inDissent && TAKTO_TAIL_RE.test(plainText);

/**
 * What follows the title of a separate opinion's heading on its line, or
 * `undefined` for a line that is no such heading. The court numbers some of
 * these headings; the number is stripped for the match alone, because the
 * heading block carries the line the court printed.
 */
const opinionHeadingTail = (line: ParsedLineData): string | undefined => {
  const { plainText } = stripInlineLinePrefix(line, NUMBERED_PARA_RE).line;
  if (plainText.length > DISSENT_HEADING_MAX_CHARS) {
    return undefined;
  }
  const tail = (
    DISSENT_HEADING_RE.exec(plainText) ??
    BARE_OPINION_HEADING_RE.exec(plainText)
  )?.groups?.["tail"];
  return tail !== undefined && DISSENT_HEADING_TAIL_RE.test(tail)
    ? tail
    : undefined;
};

/**
 * A Roman-numbered line that reads as a section title: one that opens with
 * a capital, a number or a subsection letter ("IV. 1. Obecná východiska",
 * "V. a)"), not a sentence that starts with an ordinal ("II. senát Ústavního
 * soudu nepovažoval …"), and one that does not break off mid-sentence.
 */
const readsAsSectionTitle = (text: string): boolean => {
  const title = text.replace(/^[IVXLC]+\.\s*/u, "");
  return (
    /^(?:[\p{Lu}\d§]|\p{Ll}[.)](?:\s|$))/u.test(title) &&
    !UNFINISHED_TITLE_RE.test(title)
  );
};

type AuthorContinuationOptions = {
  heading: ParsedLineData;
  i: number;
  lines: readonly ParsedLine[];
  state: UsClassificationState;
};

/**
 * A separate opinion's heading together with the lines naming its authors
 * ("STANOVISKO" / "soudců Ústavního soudu … JUDr. P. H., …"), which the
 * court set beneath the heading rather than on it. The lines join the
 * heading as printed; only their role changes.
 */
const withAuthorContinuation = ({
  heading,
  i,
  lines,
  state,
}: AuthorContinuationOptions): { inlines: Inline[]; plainText: string } => {
  const inlines = [...heading.inlines];
  let { plainText } = heading;
  let next = findNextNonEmpty(lines, i + 1);
  if (
    next === undefined ||
    !AUTHOR_CONTINUATION_RE.test(next.value.plainText)
  ) {
    return { inlines, plainText };
  }
  while (
    next !== undefined &&
    /^\p{Ll}/u.test(next.value.plainText) &&
    plainText.length + 1 + next.value.plainText.length <=
      DISSENT_TITLE_MAX_CHARS
  ) {
    inlines.push({ type: "text", text: " " }, ...next.value.inlines);
    plainText = `${plainText} ${next.value.plainText}`;
    state.consumedLines.add(next);
    next = findNextNonEmpty(lines, lines.indexOf(next) + 1);
  }
  return { inlines, plainText };
};

export const classifyUsDocumentLines = (
  lines: readonly ParsedLine[],
): Block[] => {
  const blocks: Block[] = [];
  const state: UsClassificationState = {
    blockCounter: 0,
    blockIndex: 0,
    inRuling: false,
    inOduvodneni: false,
    inDissent: false,
    sawHolding: false,
    consumedLines: new Set(),
  };

  for (const [i, line] of lines.entries()) {
    if (state.consumedLines.has(line)) {
      continue;
    }
    if (line.kind === "body") {
      classifyUsBodyLine({ body: line, i, lines, blocks, state });
      continue;
    }
    const { value, label, noteId } = line.note;
    if (value.plainText.length === 0) {
      continue;
    }
    state.blockIndex += 1;
    blocks.push({
      id: makeUsBlockId(state),
      anchorId: makeAnchorId("p", state.blockIndex),
      type: "paragraph",
      role: "apparatus",
      note: { type: "footnote", label, noteId },
      inlines: value.inlines,
      plainText: value.plainText,
    });
  }

  return blocks;
};

// ── Helpers ────────────────────────────────────────────────

/** Find the next line with non-empty plainText. */
const findNextNonEmpty = (
  lines: readonly ParsedLine[],
  startIndex: number,
): BodyDocumentLine<ParsedLineData> | undefined => {
  for (let j = startIndex; j < lines.length; j++) {
    const line = lines[j];
    if (line?.kind === "body" && line.value.plainText) {
      return line;
    }
  }
  return undefined;
};
