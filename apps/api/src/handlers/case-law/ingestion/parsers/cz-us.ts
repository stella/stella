/**
 * Czech Constitutional Court (Ustavni soud) HTML parser.
 *
 * Converts HTML from nalus.usoud.cz/Search/GetText.aspx
 * into a canonical DocumentAst.
 *
 * The HTML uses a `<table class="DocContent">` for the decision
 * body, with `<br />` line breaks (no `<p>` or semantic paragraph
 * structure). Metadata lives in `<span>` elements with IDs
 * like `lblRegistrySign`, `lblDecisionForm`, etc.
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
import type { AnyNode } from "domhandler";

import type {
  Block,
  DocumentAst,
  Inline,
} from "@/api/handlers/case-law/document-ast";
import { validateAndLog } from "@/api/handlers/case-law/ingestion/parsers/validate-ast";

// ── Public API ─────────────────────────────────────────────

export type ParseUsDecisionInput = {
  html: string;
  caseNumber: string;
  ecli: string | undefined;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
};

export type ParseUsDecisionOutput = {
  documentAst: DocumentAst;
  fulltext: string;
};

export const parseUsDecisionHtml = (
  input: ParseUsDecisionInput,
): ParseUsDecisionOutput => {
  const $ = cheerio.load(input.html);
  const lines = extractLines($);
  const blocks = classifyLines(lines);

  validateAndLog("cz-us", input.caseNumber, input.html, blocks);

  const fulltext = blocks
    .map((b) => b.plainText)
    .filter(Boolean)
    .join("\n\n");

  const ast: DocumentAst = {
    version: 1,
    source: {
      system: "nalus.usoud.cz",
      documentId: input.caseNumber,
      webUrl: "",
      printUrl: "",
    },
    metadata: {
      caseNumber: input.caseNumber,
      ecli: input.ecli ?? null,
      court: input.court,
      decisionDate: input.decisionDate ?? null,
      decisionType: input.decisionType ?? null,
      keywords: [],
      statutes: [],
    },
    blocks,
  };

  return { documentAst: ast, fulltext };
};

// ── Inline walking ─────────────────────────────────────────

// oxlint-disable-next-line no-unused-vars -- recursive-only; kept for future rich-inline extraction
const _walkInlines = (
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<AnyNode>,
): Inline[] => {
  const inlines: Inline[] = [];

  el.contents().each((_, node) => {
    // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
    if (node.type === "text") {
      const text = $(node).text();
      if (text) {
        inlines.push({ type: "text", text });
      }
      return;
    }

    // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
    if (node.type !== "tag") {
      return;
    }

    const tag = node.tagName.toLowerCase();
    const $node = $(node);

    if (tag === "br") {
      inlines.push({ type: "line-break" });
      return;
    }

    if (tag === "b" || tag === "strong") {
      const children = _walkInlines($, $node);
      if (children.length > 0) {
        inlines.push({ type: "bold", children });
      }
      return;
    }

    if (tag === "i" || tag === "em") {
      const children = _walkInlines($, $node);
      if (children.length > 0) {
        inlines.push({ type: "italic", children });
      }
      return;
    }

    if (tag === "a") {
      const href = $node.attr("href");
      const children = _walkInlines($, $node);
      if (href && children.length > 0) {
        inlines.push({ type: "link", href, children });
      } else if (children.length > 0) {
        inlines.push(...children);
      }
      return;
    }

    // Unwrap presentational wrappers (span, font, etc.)
    inlines.push(..._walkInlines($, $node));
  });

  return inlines;
};

const inlinesToPlainText = (inlines: Inline[]): string => {
  let text = "";
  for (const node of inlines) {
    if (node.type === "text") {
      text += node.text;
    } else if (node.type === "line-break") {
      text += "\n";
    } else if ("children" in node) {
      text += inlinesToPlainText(node.children);
    }
  }
  return text;
};

/** Create a simple text inline helper. */
const textInline = (text: string): Inline[] => [{ type: "text", text }];

// ── Line extraction ────────────────────────────────────────

type ParsedLine = {
  inlines: Inline[];
  plainText: string;
};

/**
 * Extract lines from the DocContent table.
 *
 * The US HTML uses `<br />` tags as line separators inside a
 * single table cell. We split on `<br>` boundaries, then
 * group consecutive non-empty lines into logical paragraphs
 * separated by blank lines (2+ consecutive `<br>`).
 */
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
  // Split at:
  // - After a period, before a numbered paragraph ("1. ")
  // - Before section markers (Odůvodnění:, Poučení:)
  // - Before closing pattern (V Brně dne)
  const parts = text.split(
    /(?<=\.)(?=\d{1,3}\.\s)|(?=Odůvodnění\s*:)|(?=Poučení\s*:)|(?=V\s+\p{Lu}\p{Ll}+\s+(?:dne\s+)?\d)/u,
  );
  return parts.length > 1 ? parts : [text];
};

const extractLines = ($: cheerio.CheerioAPI): ParsedLine[] => {
  const docContent = $(".DocContent");
  const container = docContent.length > 0 ? docContent : $("body");

  // ÚS HTML has the decision body inside a nested <td>
  // with minimal <br> breaks. Extract the full text and
  // split at paragraph boundaries instead.
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

// ── Patterns ───────────────────────────────────────────────

/** Decorative lines to skip entirely. */
const SKIP_RE = /^\[OBRÁZEK\]|^Česká republika$|^ČESKÁ REPUBLIKA$/;

/** Decision title (level 1). */
const TITLE_RE =
  /^(N\s*[ÁA]\s*L\s*[ÉE]\s*Z|U\s*S\s*N\s*E\s*S\s*E\s*N\s*[ÍI]|Ústavního soudu|Jménem republiky)$/i;

/** Normalize spaced text like "t a k t o" -> "takto". */
const collapseSpaces = (text: string): string =>
  text.replace(/(\S)\s+(?=\S)/g, "$1");

/** "takto:" separator (with spaced variants). */
const TAKTO_RE = /^t\s*a\s*k\s*t\s*o\s*:?\s*$/i;

/** "Odůvodnění:" separator (with spaced variants). */
const ODUVODNENI_RE =
  /^(?:O\s*d\s*[uů]\s*v\s*o\s*d\s*n\s*[eě]\s*n\s*[ií]|Odůvodnění)\s*:?\s*$/i;

/** Ruling item: "I. ...", "II. ..." (Roman numeral prefix). */
const RULING_ITEM_RE = /^((?:X{0,3}(?:IX|IV|V?I{0,3})))\.\s+(.+)/;

/**
 * Section heading in Odůvodnění: standalone Roman numeral,
 * or Roman numeral followed by a short title on the same or
 * next line.
 */
const SECTION_ROMAN_RE = /^((?:X{0,3}(?:IX|IV|V?I{0,3})))\.?\s*$/;

/** Numbered paragraph: "1. ...", "2. ..." */
const NUMBERED_PARA_RE = /^(\d+)\.\s+/;

/** Closing: "V Brně dne ..." */
const CLOSING_RE = /^V\s+\p{Lu}\p{Ll}+\s+(?:dne\s+)?\d/u;

/** Signature: judge title patterns. */
const SIGNATURE_RE =
  /předsed(?:a|kyně)\s+senátu|soudce?\s+zpravodaj|v\.\s*r\.\s*$/i;

/** Judge name line (academic title prefix). */
const JUDGE_NAME_RE = /^(JUDr\.|Mgr\.|doc\.|prof\.|PhDr\.)\s+/;

// ── Block classification ───────────────────────────────────

let blockCounter = 0;

const makeBlockId = (): string => {
  blockCounter += 1;
  return `b${blockCounter}`;
};

const makeAnchorId = (prefix: string, index: number): string =>
  `${prefix}-${index}`;

/**
 * Strip a character-counted prefix from inlines.
 */
const stripInlinePrefix = (inlines: Inline[], charCount: number): Inline[] => {
  if (charCount <= 0) {
    return inlines;
  }

  const result: Inline[] = [];
  let remaining = charCount;

  for (const node of inlines) {
    if (remaining <= 0) {
      result.push(node);
      continue;
    }

    if (node.type === "text") {
      if (node.text.length <= remaining) {
        remaining -= node.text.length;
      } else {
        const rest = node.text.slice(remaining);
        remaining = 0;
        if (rest) {
          result.push({ type: "text", text: rest });
        }
      }
      continue;
    }

    if (node.type === "line-break") {
      remaining -= 1;
      continue;
    }

    if ("children" in node) {
      const nodeTextLen = inlinesToPlainText(node.children).length;
      if (nodeTextLen <= remaining) {
        remaining -= nodeTextLen;
      } else {
        const stripped = stripInlinePrefix(node.children, remaining);
        remaining = 0;
        if (stripped.length > 0) {
          result.push({ ...node, children: stripped });
        }
      }
    }
  }

  // Trim leading whitespace from the first text node
  const first = result[0];
  if (result.length > 0 && first?.type === "text") {
    const trimmed = first.text.trimStart();
    if (trimmed) {
      result[0] = { type: "text", text: trimmed };
    } else {
      result.shift();
    }
  }

  return result;
};

/**
 * Classify extracted lines into semantic blocks.
 *
 * Tracks parser state across three zones:
 *   1. Preamble (before "takto:")
 *   2. Výrok / ruling zone (between "takto:" and "Odůvodnění:")
 *   3. Odůvodnění zone (after "Odůvodnění:")
 */
const classifyLines = (lines: ParsedLine[]): Block[] => {
  blockCounter = 0;
  const blocks: Block[] = [];
  let blockIndex = 0;

  let inRuling = false;
  let inOduvodneni = false;

  for (let i = 0; i < lines.length; i++) {
    // SAFETY: i is bounded by lines.length
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const line = lines[i]!;
    const { plainText, inlines } = line;

    // Skip empty sentinel lines (paragraph breaks)
    if (!plainText) {
      continue;
    }

    // Skip decorative lines
    if (SKIP_RE.test(plainText)) {
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

    // Ruling items (in the ruling zone)
    if (inRuling && !inOduvodneni) {
      const rulingMatch = plainText.match(RULING_ITEM_RE);
      if (rulingMatch) {
        const label = `${rulingMatch[1] ?? ""}.`;
        const text = (rulingMatch[2] ?? "").trim();
        const prefixLen = rulingMatch[0].length - text.length;
        blockIndex += 1;
        blocks.push({
          id: makeBlockId(),
          anchorId: makeAnchorId("r", blockIndex),
          type: "ruling-item",
          label,
          inlines: stripInlinePrefix(inlines, prefixLen),
          plainText: text,
        });
        continue;
      }

      // Non-Roman-numeral text in ruling zone: holding paragraph
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

    // Section headings in Odůvodnění: standalone Roman numeral
    // possibly followed by a title on the next line
    if (inOduvodneni) {
      const romanMatch = plainText.match(SECTION_ROMAN_RE);
      if (romanMatch) {
        // Check if the next non-empty line is a short title
        const nextNonEmpty = findNextNonEmpty(lines, i + 1);
        if (
          nextNonEmpty &&
          nextNonEmpty.plainText.length < 120 &&
          !NUMBERED_PARA_RE.test(nextNonEmpty.plainText) &&
          !SECTION_ROMAN_RE.test(nextNonEmpty.plainText) &&
          !CLOSING_RE.test(nextNonEmpty.plainText)
        ) {
          // Combine Roman numeral + title line
          const combinedText = `${romanMatch[1] ?? ""}. ${nextNonEmpty.plainText}`;
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
          skipToLine(lines, i, nextNonEmpty);
          i = lines.indexOf(nextNonEmpty);
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
    const numMatch = plainText.match(NUMBERED_PARA_RE);
    if (numMatch) {
      const strippedText = plainText.slice(numMatch[0].length).trim();
      const strippedInlines = stripInlinePrefix(inlines, numMatch[0].length);
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("p", blockIndex),
        type: "paragraph",
        inlines:
          strippedInlines.length > 0
            ? strippedInlines
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
      inlines,
      plainText,
    });
  }

  return blocks;
};

// ── Helpers ────────────────────────────────────────────────

/** Find the next line with non-empty plainText. */
const findNextNonEmpty = (
  lines: ParsedLine[],
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

/**
 * No-op placeholder; the skip is handled by reassigning `i`
 * in the caller. Kept for clarity of intent.
 */
const skipToLine = (
  _lines: ParsedLine[],
  _current: number,
  _target: ParsedLine,
): void => {
  // Intentionally empty; the caller sets `i` directly.
};
