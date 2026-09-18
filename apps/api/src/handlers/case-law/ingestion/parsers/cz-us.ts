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

import * as cheerio from "cheerio";

import { caseLawSectionHeading } from "@stll/legal-ast/case-law-heading";
import {
  CZ_CLOSING_RE as CLOSING_RE,
  CZ_JUDGE_NAME_RE as JUDGE_NAME_RE,
  CZ_JUDGE_TITLE_RE as SIGNATURE_RE,
} from "@stll/legal-ast/czech-document-roles";

import type {
  Block,
  DocumentAst,
  Inline,
  ParagraphRole,
} from "@/api/handlers/case-law/document-ast";
import {
  buildValidationHtml,
  validateAndLog,
} from "@/api/lib/legal-search/parsers/validate-ast";

import {
  inlinesToPlainText,
  stripFurniturePrefix,
  stripInlinePrefix,
} from "./shared-inlines";

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
  documentAst: DocumentAst;
  fulltext: string;
  /** Cross-references to other decisions found in the HTML. */
  crossReferences: CrossReference[];
};

export const parseUsDecisionHtml = (
  input: ParseUsDecisionInput,
): ParseUsDecisionOutput => {
  const $ = cheerio.load(input.html);

  // Extract metadata from hidden fields
  const hiddenMeta = extractHiddenMetadata($);

  // Extract cross-reference links from the visible HTML
  const crossReferences = extractCrossReferences($);

  const lines = extractLines($);
  const blocks = classifyLines(lines);

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
  const validationHtml = buildValidationHtml(lines.map((l) => l.plainText));
  validateAndLog(
    { parser: "cz-us", caseNumber: input.caseNumber },
    validationHtml,
    blocks,
  );

  const fulltext = blocks
    .flatMap((b) => (b.plainText ? [b.plainText] : []))
    .join("\n\n");

  const ast: DocumentAst = {
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

  return { documentAst: ast, fulltext, crossReferences };
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
  decisionForm: $("span#lblDecisionForm").text().trim() || null,
});

// ── Cross-reference extraction ────────────────────────────

const CROSS_REF_HREF_RE = /GetRegSignDecisions\.aspx\?sz=/iu;

/**
 * Extract cross-reference links to other ÚS decisions from
 * the visible DocContent HTML.
 */
const extractCrossReferences = ($: cheerio.CheerioAPI): CrossReference[] => {
  const refs: CrossReference[] = [];
  const seen = new Set<string>();

  $(".DocContent a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!CROSS_REF_HREF_RE.test(href)) {
      return;
    }

    const text = $(el).text().trim();
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

// ── RTF reader ────────────────────────────────────────────

/**
 * Destinations whose group carries no document text.
 *
 * RTF 1.9 ignores an unknown `{\*\...}` destination whole, and these named
 * ones hold a picture's payload, the font and colour tables, the
 * revision-save-id table or the document properties. Read as text instead,
 * a picture group puts its own control words and hundreds of hex digits
 * into the decision: Pl.ÚS-st. 27/09 prints a horizontal rule between the
 * majority opinion and the dissent, and the `\shppict`/`\nonshppict` pair
 * behind it surfaced in the reader immediately before "1. Odlišné
 * stanovisko".
 *
 * A picture becomes nothing. An `image` block needs an https asset in a
 * store, which this export does not publish, and a `data:` URI is rejected
 * because the AST is read, indexed and prompted with whole.
 */
const RTF_SKIPPED_DESTINATIONS = new Set([
  "colortbl",
  "datastore",
  "fonttbl",
  "info",
  "latentstyles",
  "listoverridetable",
  "listtable",
  "nonshppict",
  "object",
  "objdata",
  "pgptbl",
  "pict",
  "rsidtbl",
  "shp",
  "shppict",
  "stylesheet",
  "themedata",
  "xmlnstbl",
]);

/** Control words that end the current paragraph. */
const RTF_BREAK_WORDS = new Set(["line", "page", "par", "sect"]);

/** Control words that stand for one character of text. */
const RTF_SYMBOL_TEXT = new Map([
  ["bullet", "•"],
  ["emdash", "—"],
  ["emspace", " "],
  ["endash", "–"],
  ["enspace", " "],
  ["ldblquote", "“"],
  ["lquote", "‘"],
  ["qmspace", " "],
  ["rdblquote", "”"],
  ["rquote", "’"],
  ["tab", "\t"],
]);

/** A run of text sharing one font weight. */
type RtfRun = { text: string; bold: boolean };

/** Formatting a group inherits from its parent and restores on close. */
type RtfGroupState = { bold: boolean; unicodeSkip: number };

/**
 * A control word with its optional numeric argument and the single space
 * that delimits it, or a control symbol. Sticky: the reader matches at the
 * backslash it stands on rather than searching forward for one.
 */
const RTF_CONTROL_RE =
  /\\(?:(?<word>[a-zA-Z]+)(?<value>-?\d+)?[ ]?|(?<symbol>[^a-zA-Z]))/uy;

/** The destination name at `index`, where one starts there. */
const RTF_WORD_RE = /^[a-zA-Z]+/u;

/**
 * The destination a group introduces: whether it is ignorable (`{\*`) and
 * the control word that names it.
 *
 * Scanned rather than matched: the literal for this — an optional `\*`
 * between two runs of whitespace — is super-linear under scslre, and the
 * ratchet is at 0. The cursor only advances.
 */
const rtfGroupHead = (
  rtf: string,
  open: number,
): { ignorable: boolean; word: string | undefined } | undefined => {
  let index = open + 1;
  while (index < rtf.length && WHITESPACE_RE.test(rtf.charAt(index))) {
    index += 1;
  }
  if (rtf.charAt(index) !== "\\") {
    return undefined;
  }
  index += 1;
  const ignorable = rtf.charAt(index) === "*";
  if (ignorable) {
    index += 1;
    while (index < rtf.length && WHITESPACE_RE.test(rtf.charAt(index))) {
      index += 1;
    }
    if (rtf.charAt(index) !== "\\") {
      return { ignorable, word: undefined };
    }
    index += 1;
  }
  return {
    ignorable,
    word: RTF_WORD_RE.exec(rtf.slice(index, index + 32))?.[0]?.toLowerCase(),
  };
};

const WHITESPACE_RE = /\s/u;

/** Index just past the group opening at `start`, or undefined when it never closes. */
const rtfGroupEnd = (rtf: string, start: number): number | undefined => {
  let depth = 0;
  for (let i = start; i < rtf.length; i++) {
    const char = rtf.charAt(i);
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return undefined;
};

/**
 * Index just past a group to skip whole, or undefined when the group's text
 * belongs in the document.
 *
 * An unbalanced group is not skipped: its closing brace is missing, so
 * where it ends is a guess and dropping to the end of the source would drop
 * the rest of the decision with it. What leaks instead is markup, which
 * `validateAndLog`'s MARKUP_RESIDUE reports.
 */
const skippedGroupEnd = (rtf: string, open: number): number | undefined => {
  const head = rtfGroupHead(rtf, open);
  if (!head) {
    return undefined;
  }
  if (
    !head.ignorable &&
    !(head.word !== undefined && RTF_SKIPPED_DESTINATIONS.has(head.word))
  ) {
    return undefined;
  }
  return rtfGroupEnd(rtf, open);
};

/**
 * Skip the characters `\uN` prints for readers that cannot show it: `\ucN`
 * states how many, and each is a `\'hh` byte or one plain character.
 */
const skipUnicodeFallback = (
  rtf: string,
  start: number,
  count: number,
): number => {
  let index = start;
  for (let skipped = 0; skipped < count && index < rtf.length; skipped++) {
    index += rtf.startsWith("\\'", index) ? 4 : 1;
  }
  return index;
};

/**
 * Read RTF into paragraphs of formatted runs.
 *
 * Group-aware by construction: formatting is pushed and popped with the
 * braces, and a destination holding no text is skipped as one group rather
 * than filtered control word by control word. A filter only removes what it
 * was told to look for, so every unlisted control word — and every byte of
 * the payload one introduces — reached the text.
 */
const readRtfRuns = (rtf: string): RtfRun[][] => {
  const paragraphs: RtfRun[][] = [];
  const stack: RtfGroupState[] = [];
  const state: RtfGroupState = { bold: false, unicodeSkip: 1 };
  let runs: RtfRun[] = [];

  const emit = (text: string): void => {
    if (!text) {
      return;
    }
    const last = runs.at(-1);
    if (last && last.bold === state.bold) {
      last.text += text;
      return;
    }
    runs.push({ text, bold: state.bold });
  };

  const breakParagraph = (): void => {
    paragraphs.push(runs);
    runs = [];
  };

  /** Apply the control at `index`; returns the index just past it. */
  const applyControl = (index: number): number => {
    RTF_CONTROL_RE.lastIndex = index;
    const match = RTF_CONTROL_RE.exec(rtf);
    if (!match) {
      emit("\\");
      return index + 1;
    }
    const next = RTF_CONTROL_RE.lastIndex;

    const symbol = match.groups?.["symbol"];
    if (symbol !== undefined) {
      if (symbol === "\\" || symbol === "{" || symbol === "}") {
        emit(symbol);
        return next;
      }
      if (symbol === "~") {
        emit(" ");
        return next;
      }
      if (symbol === "_") {
        emit("-");
        return next;
      }
      if (symbol === "\n" || symbol === "\r") {
        breakParagraph();
        return next;
      }
      // `\'hh` is a code-page byte the hidden field already serves decoded;
      // `\-` is an optional hyphen, which prints nothing.
      return symbol === "'" ? next + 2 : next;
    }

    const word = match.groups?.["word"]?.toLowerCase();
    if (word === undefined) {
      return next;
    }
    const argument = match.groups?.["value"];
    const value =
      argument === undefined ? undefined : Number.parseInt(argument, 10);

    if (RTF_BREAK_WORDS.has(word)) {
      breakParagraph();
      return next;
    }
    const symbolText = RTF_SYMBOL_TEXT.get(word);
    if (symbolText !== undefined) {
      emit(symbolText);
      return next;
    }
    if (word === "b") {
      state.bold = value !== 0;
      return next;
    }
    if (word === "uc") {
      state.unicodeSkip = value === undefined || value < 0 ? 1 : value;
      return next;
    }
    if (word === "bin") {
      return value === undefined || value < 0 ? next : next + value;
    }
    if (word === "u" && value !== undefined) {
      emit(String.fromCodePoint(value < 0 ? value + 0x01_00_00 : value));
      return skipUnicodeFallback(rtf, next, state.unicodeSkip);
    }
    return next;
  };

  let index = 0;
  while (index < rtf.length) {
    const char = rtf.charAt(index);
    if (char === "{") {
      const skipTo = skippedGroupEnd(rtf, index);
      if (skipTo !== undefined) {
        index = skipTo;
        continue;
      }
      stack.push({ ...state });
      index += 1;
      continue;
    }
    if (char === "}") {
      const popped = stack.pop();
      if (popped) {
        state.bold = popped.bold;
        state.unicodeSkip = popped.unicodeSkip;
      }
      index += 1;
      continue;
    }
    if (char === "\\") {
      index = applyControl(index);
      continue;
    }
    emit(char);
    index += 1;
  }

  breakParagraph();
  return paragraphs;
};

/** Formatted runs as inline nodes, with the paragraph's outer padding trimmed. */
const runsToInlines = (runs: readonly RtfRun[]): Inline[] => {
  const trimmed = runs.map((run) => ({ ...run }));
  const first = trimmed.at(0);
  if (first) {
    first.text = first.text.trimStart();
  }
  const last = trimmed.at(-1);
  if (last) {
    last.text = last.text.trimEnd();
  }

  const inlines: Inline[] = [];
  for (const run of trimmed) {
    if (!run.text) {
      continue;
    }
    const text: Inline = { type: "text", text: run.text };
    inlines.push(run.bold ? { type: "bold", children: [text] } : text);
  }
  return inlines;
};

// ── Line extraction ────────────────────────────────────────

type ParsedLine = {
  inlines: Inline[];
  plainText: string;
};

/**
 * Primary extraction: read the `docContentHidden` RTF field.
 *
 * One line per RTF paragraph (`\par` and its siblings); an empty one
 * carries nothing and is dropped.
 */
const extractLinesFromRtf = (rtfContent: string): ParsedLine[] => {
  const lines: ParsedLine[] = [];
  for (const runs of readRtfRuns(rtfContent)) {
    const inlines = runsToInlines(runs);
    const plainText = inlinesToPlainText(inlines).trim();
    if (plainText) {
      lines.push({ inlines, plainText });
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
const extractLinesFromDocContent = ($: cheerio.CheerioAPI): ParsedLine[] => {
  const docContent = $(".DocContent");
  const container = docContent.length > 0 ? docContent : $("body");

  const fullText = container.text().trim();
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
      inlines: [{ type: "text", text: trimmed }],
      plainText: trimmed,
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
const extractLines = ($: cheerio.CheerioAPI): ParsedLine[] => {
  const rtfContent = $("input#docContentHidden").attr("value") ?? "";

  if (rtfContent.trim()) {
    return extractLinesFromRtf(rtfContent);
  }

  // Fallback: parse the visible DocContent HTML
  return extractLinesFromDocContent($);
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

/**
 * Heading opening a separate opinion. The court prints it either on its own
 * or as the next enumerated item, and names the dissenting judges after it,
 * so the pattern is anchored at the start and bounded by length rather than
 * closed at the end.
 */
const DISSENT_HEADING_RE =
  /^(?:Odli[šs]n[ée]\s+stanovisko|Odli[šs]n[áa]\s+stanoviska|Stanovisko\s+men[šs]iny)\b/iu;
const DISSENT_HEADING_MAX_CHARS = 120;

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
const classifyLines = (lines: readonly ParsedLine[]): Block[] => {
  let blockCounter = 0;
  const makeBlockId = (): string => {
    blockCounter += 1;
    return `b${blockCounter}`;
  };
  const blocks: Block[] = [];
  let blockIndex = 0;

  let inRuling = false;
  let inOduvodneni = false;
  let inDissent = false;
  const bodyRole = (): ParagraphRole | undefined =>
    inDissent ? "dissent" : undefined;
  const consumedLines = new Set<ParsedLine>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines.at(i);
    if (!line) {
      continue;
    }
    if (consumedLines.has(line)) {
      continue;
    }
    // Skip empty sentinel lines (paragraph breaks)
    if (!line.plainText) {
      continue;
    }

    // Peel the emblem rather than dropping the line it is glued to, then skip
    // what turns out to have been decoration and nothing else.
    const inlines = stripFurniturePrefix(line.inlines, EMBLEM_PREFIX_RE);
    const plainText = inlinesToPlainText(inlines).trim();
    if (!plainText || DECORATIVE_LINE_RE.test(plainText)) {
      continue;
    }

    // Decision title: NALEZ, USNESENI, etc.
    const collapsed = collapseSpaces(plainText);
    if (TITLE_RE.test(plainText) || TITLE_RE.test(collapsed)) {
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("h", blockIndex),
        type: "heading",
        level: 1,
        role: "decision-title",
        inlines,
        plainText,
      });
      continue;
    }

    // "takto:" separator
    if (TAKTO_RE.test(plainText) || TAKTO_RE.test(collapsed)) {
      inRuling = true;
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("h", blockIndex),
        type: "heading",
        level: 2,
        role: "section-heading",
        inlines: textInline("takto:"),
        plainText: "takto:",
      });
      continue;
    }

    // "Odůvodnění:" separator
    if (ODUVODNENI_RE.test(plainText) || ODUVODNENI_RE.test(collapsed)) {
      inRuling = false;
      inOduvodneni = true;
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("h", blockIndex),
        type: "heading",
        level: 2,
        role: "section-heading",
        inlines: textInline("Odůvodnění:"),
        plainText: "Odůvodnění:",
      });
      continue;
    }

    // A separate opinion runs to the end of the document, so the heading
    // opens a zone rather than a section.
    const numberPrefix = NUMBERED_PARA_RE.exec(plainText)?.[0] ?? "";
    const unnumberedText = plainText.slice(numberPrefix.length);
    const unnumberedInlines = stripInlinePrefix(inlines, numberPrefix.length);
    if (
      unnumberedText.length <= DISSENT_HEADING_MAX_CHARS &&
      DISSENT_HEADING_RE.test(unnumberedText)
    ) {
      inDissent = true;
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("h", blockIndex),
        type: "heading",
        level: 2,
        role: "section-heading",
        inlines:
          unnumberedInlines.length > 0
            ? unnumberedInlines
            : textInline(unnumberedText),
        plainText: unnumberedText,
      });
      continue;
    }

    // Closing: "V Brně dne ..."
    if (CLOSING_RE.test(plainText)) {
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("p", blockIndex),
        type: "paragraph",
        role: "closing",
        inlines,
        plainText,
      });
      continue;
    }

    // Signature: judge title line
    if (SIGNATURE_RE.test(plainText) && plainText.length < 80) {
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("p", blockIndex),
        type: "paragraph",
        role: "signature",
        inlines,
        plainText,
      });
      continue;
    }

    // Judge name line (short, academic title prefix;
    // only at the tail of the document)
    if (JUDGE_NAME_RE.test(plainText) && plainText.length < 80 && !inRuling) {
      // Look ahead: if the next non-empty line is a
      // signature or another judge name, treat as signature.
      const nextNonEmpty = findNextNonEmpty(lines, i + 1);
      if (
        !nextNonEmpty ||
        SIGNATURE_RE.test(nextNonEmpty.plainText) ||
        JUDGE_NAME_RE.test(nextNonEmpty.plainText) ||
        CLOSING_RE.test(nextNonEmpty.plainText)
      ) {
        blockIndex += 1;
        blocks.push({
          id: makeBlockId(),
          anchorId: makeAnchorId("p", blockIndex),
          type: "paragraph",
          role: "signature",
          inlines,
          plainText,
        });
        continue;
      }
    }

    // Ruling items (in the ruling zone): detected by Roman
    // numeral prefix, emitted as holding paragraphs with
    // the full original text preserved.
    if (inRuling && !inOduvodneni) {
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("p", blockIndex),
        type: "paragraph",
        role: "holding",
        inlines,
        plainText,
      });
      continue;
    }

    // Section headings in Odůvodnění: standalone Roman
    // numeral possibly followed by a title on the next line
    if (inOduvodneni) {
      const titledRoman = caseLawSectionHeading(plainText);
      if (titledRoman !== null) {
        blockIndex += 1;
        blocks.push({
          id: makeBlockId(),
          anchorId: makeAnchorId("h", blockIndex),
          type: "heading",
          level: titledRoman.level,
          inlines,
          plainText,
        });
        continue;
      }

      const romanMatch = SECTION_ROMAN_RE.exec(plainText);
      if (romanMatch) {
        // Check if next non-empty line is a short title
        const nextNonEmpty = findNextNonEmpty(lines, i + 1);
        if (
          nextNonEmpty &&
          nextNonEmpty.plainText.length < 120 &&
          !NUMBERED_PARA_RE.test(nextNonEmpty.plainText) &&
          !SECTION_ROMAN_RE.test(nextNonEmpty.plainText) &&
          !CLOSING_RE.test(nextNonEmpty.plainText)
        ) {
          // Combine Roman numeral + title line
          const combinedText = `${romanMatch.groups?.["roman"] ?? ""}. ${nextNonEmpty.plainText}`;
          blockIndex += 1;
          blocks.push({
            id: makeBlockId(),
            anchorId: makeAnchorId("h", blockIndex),
            type: "heading",
            level: 3,
            inlines: textInline(combinedText),
            plainText: combinedText,
          });
          // Skip the consumed title line
          consumedLines.add(nextNonEmpty);
          continue;
        }

        // Standalone Roman numeral heading
        const headingText = `${romanMatch[1] ?? ""}.`;
        blockIndex += 1;
        blocks.push({
          id: makeBlockId(),
          anchorId: makeAnchorId("h", blockIndex),
          type: "heading",
          level: 3,
          inlines: textInline(headingText),
          plainText: headingText,
        });
        continue;
      }
    }

    // Numbered paragraphs: "1. ...", "2. ..."
    if (numberPrefix.length > 0) {
      const strippedText = unnumberedText.trim();
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("p", blockIndex),
        type: "paragraph",
        role: bodyRole(),
        inlines:
          unnumberedInlines.length > 0
            ? unnumberedInlines
            : textInline(strippedText),
        plainText: strippedText,
      });
      continue;
    }

    // Default: paragraph
    blockIndex += 1;
    blocks.push({
      id: makeBlockId(),
      anchorId: makeAnchorId("p", blockIndex),
      type: "paragraph",
      role: bodyRole(),
      inlines,
      plainText,
    });
  }

  return blocks;
};

// ── Helpers ────────────────────────────────────────────────

/** Find the next line with non-empty plainText. */
const findNextNonEmpty = (
  lines: readonly ParsedLine[],
  startIndex: number,
): ParsedLine | undefined => {
  for (let j = startIndex; j < lines.length; j++) {
    const line = lines[j];
    if (line?.plainText) {
      return line;
    }
  }
  return undefined;
};
