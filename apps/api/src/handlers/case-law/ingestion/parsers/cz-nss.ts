/**
 * Czech Supreme Administrative Court (NSS) HTML parser.
 *
 * Converts Aspose.Words HTML from vyhledavac.nssoud.cz
 * /DokumentOriginal/Html/{id} into a canonical DocumentAst.
 *
 * The HTML uses <p> elements with inline styles for alignment
 * and <span> elements with font-weight/font-style for emphasis.
 * Paragraph numbers appear as [N] at the start of paragraphs.
 *
 * Structure:
 *   case number + "pokračování"
 *   [OBRÁZEK] / ČESKÁ REPUBLIKA
 *   ROZSUDEK / USNESENÍ + JMÉNEM REPUBLIKY
 *   intro paragraph ("Nejvyšší správní soud rozhodl...")
 *   takto:
 *   I. / II. / III. ... (ruling items)
 *   Odůvodnění:
 *   I. Section heading / II. Section heading ...
 *   [1] ... [2] ... (numbered paragraphs)
 *   Poučení:
 *   V Brně dne ...
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

import {
  CZ_CLOSING_RE as CLOSING_RE,
  CZ_JUDGE_TITLE_RE as SIGNATURE_RE,
} from "./cz-patterns";

// ── Public API ─────────────────────────────────────────────

export type ParseNssDecisionInput = {
  caseNumber: string;
  ecli: string | undefined;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  sourceUrl: string | undefined;
  /** Rich HTML from /DokumentOriginal/Html/{id}. */
  html: string;
  /** Structured metadata from the detail page. */
  detailMetadata: Record<string, unknown>;
};

type ParseNssDecisionOutput = {
  documentAst: DocumentAst;
  fulltext: string;
};

export const parseNssDecisionHtml = (
  input: ParseNssDecisionInput,
): ParseNssDecisionOutput => {
  const $ = cheerio.load(input.html);
  const chunks = extractChunks($);
  const blocks = classifyChunks(chunks);

  validateAndLog("cz-nss", input.caseNumber, input.html, blocks);

  const fulltext = blocks
    .map((b) => b.plainText)
    .filter(Boolean)
    .join("\n\n");

  const ast: DocumentAst = {
    version: 1,
    source: {
      system: "nssoud.cz",
      documentId: input.caseNumber,
      webUrl: input.sourceUrl ?? "",
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

/**
 * Walk a cheerio element tree and produce Inline nodes.
 * Handles the Aspose.Words span-based markup where bold/italic
 * are expressed via inline styles rather than semantic tags.
 */
const walkInlines = (
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

    // Extract alt text from images (e.g., decorative headers,
    // embedded labels). Some decisions embed meaningful text
    // in <img alt="...">.
    if (tag === "img") {
      const alt = $node.attr("alt")?.trim();
      if (alt) {
        inlines.push({ type: "text", text: alt });
      }
      return;
    }

    if (tag === "span") {
      const style = $node.attr("style") ?? "";

      // Skip Aspose spacer spans only when they contain no
      // meaningful text. Modern exports use these for tab stops
      // and invisible fills (whitespace-only), but older 2004-era
      // conversions sometimes place real words inside them.
      if (
        style.includes("-aw-import:ignore") ||
        style.includes("-aw-import:spaces") ||
        style.includes("display:inline-block")
      ) {
        const innerText = $node.text().trim();
        if (!innerText) {
          return;
        }
      }

      const isBold = style.includes("font-weight:bold");
      const isItalic = style.includes("font-style:italic");

      const children = walkInlines($, $node);
      if (children.length === 0) {
        return;
      }

      if (isBold && isItalic) {
        inlines.push({
          type: "bold",
          children: [{ type: "italic", children }],
        });
      } else if (isBold) {
        inlines.push({ type: "bold", children });
      } else if (isItalic) {
        inlines.push({ type: "italic", children });
      } else {
        inlines.push(...children);
      }
      return;
    }

    if (tag === "b" || tag === "strong") {
      const children = walkInlines($, $node);
      if (children.length > 0) {
        inlines.push({ type: "bold", children });
      }
      return;
    }

    if (tag === "i" || tag === "em") {
      const children = walkInlines($, $node);
      if (children.length > 0) {
        inlines.push({ type: "italic", children });
      }
      return;
    }

    if (tag === "a") {
      const href = $node.attr("href");
      const children = walkInlines($, $node);
      if (href && children.length > 0) {
        inlines.push({ type: "link", href, children });
      } else if (children.length > 0) {
        inlines.push(...children);
      }
      return;
    }

    // Unwrap other tags
    inlines.push(...walkInlines($, $node));
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

// ── Chunk extraction ───────────────────────────────────────

type PChunk = {
  inlines: Inline[];
  plainText: string;
  centered: boolean;
  bold: boolean;
  letterSpacing: boolean;
  fontSize: number;
  /** Set when the chunk comes from an <ol type="I"><li>. */
  listItemIndex: number | null;
};

/** Convert a 1-based index to a Roman numeral. */
const toRoman = (n: number): string => {
  const vals = [10, 9, 5, 4, 1] as const;
  const syms = ["X", "IX", "V", "IV", "I"] as const;
  let result = "";
  let remaining = n;
  for (let i = 0; i < vals.length; i++) {
    const value = vals.at(i);
    const symbol = syms.at(i);
    if (value === undefined || symbol === undefined) {
      continue;
    }
    while (remaining >= value) {
      result += symbol;
      remaining -= value;
    }
  }
  return result;
};

/**
 * Extract content chunks from the HTML body.
 * Handles both <p> elements and <ol type="I"><li> elements
 * (ruling items use ordered lists in Aspose output).
 */
const extractChunks = ($: cheerio.CheerioAPI): PChunk[] => {
  const chunks: PChunk[] = [];

  // Skip the first-page header div (Aspose artifact)
  const body = $("body");
  body.find("div[style*='-aw-headerfooter-type']").remove();

  // Walk top-level children in document order to
  // preserve the correct sequence of <p>, <ol>, <div>,
  // and <table>. Some decisions use <div> for content
  // blocks (e.g., cost breakdowns, footnotes).
  body.find("p, ol, table, div").each((_, el) => {
    const $el = $(el);
    const tag = el.tagName.toLowerCase();

    // Skip <div> elements that contain child block
    // elements — those children are matched separately
    // by the selector, so processing the <div> would
    // double-count. Only process leaf-level <div>s.
    if (tag === "div") {
      if ($el.find("p, ol, table, div").length > 0) {
        return;
      }

      const style = $el.attr("style") ?? "";
      const inlines = walkInlines($, $el);
      const plainText = inlinesToPlainText(inlines).trim();
      if (!plainText) {
        return;
      }

      const centered = style.includes("text-align:center");
      const fontSize = parseFontSize(style);
      const boldSpans = $el.find("span[style*='font-weight:bold']");
      const boldText = boldSpans.text().trim();
      const bold =
        boldText.length > 0 && boldText.length >= plainText.length * 0.7;
      const letterSpacing =
        style.includes("letter-spacing") ||
        $el.find("span[style*='letter-spacing']").length > 0;

      chunks.push({
        inlines,
        plainText,
        centered,
        bold,
        letterSpacing,
        fontSize,
        listItemIndex: null,
      });
      return;
    }

    if (tag === "table") {
      // Extract each row as a paragraph. Cell values are
      // joined with " | " to preserve tabular structure
      // in plain text (e.g., cost breakdowns, fee summaries).
      $el.find("tr").each((_tr, trEl) => {
        const cells: string[] = [];
        const cellInlines: Inline[] = [];

        $(trEl)
          .find("td, th")
          .each((_td, tdEl) => {
            const cellText = $(tdEl).text().trim();
            if (cellText) {
              cells.push(cellText);
              if (cellInlines.length > 0) {
                cellInlines.push({
                  type: "text",
                  text: " | ",
                });
              }
              cellInlines.push({
                type: "text",
                text: cellText,
              });
            }
          });

        const plainText = cells.join(" | ");
        if (!plainText) {
          return;
        }

        chunks.push({
          inlines: cellInlines,
          plainText,
          centered: false,
          bold: false,
          letterSpacing: false,
          fontSize: 12,
          listItemIndex: null,
        });
      });
      return;
    }

    if (tag === "ol") {
      // Ruling items: <ol type="I"><li>...
      const startAttr = $el.attr("start");
      let listStart = startAttr ? Number.parseInt(startAttr, 10) : 1;

      $el.find("> li").each((_li, liEl) => {
        const $li = $(liEl);
        const inlines = walkInlines($, $li);
        const plainText = inlinesToPlainText(inlines).trim();

        if (!plainText) {
          listStart++;
          return;
        }

        chunks.push({
          inlines,
          plainText,
          centered: false,
          bold: false,
          letterSpacing: false,
          fontSize: 12,
          listItemIndex: listStart,
        });
        listStart++;
      });
      return;
    }

    // Regular <p>
    const style = $el.attr("style") ?? "";
    const inlines = walkInlines($, $el);
    const plainText = inlinesToPlainText(inlines).trim();

    if (!plainText) {
      return;
    }

    const centered = style.includes("text-align:center");
    const fontSize = parseFontSize(style);

    const boldSpans = $el.find("span[style*='font-weight:bold']");
    const boldText = boldSpans.text().trim();
    const bold =
      boldText.length > 0 && boldText.length >= plainText.length * 0.7;

    const letterSpacing =
      style.includes("letter-spacing") ||
      $el.find("span[style*='letter-spacing']").length > 0;

    chunks.push({
      inlines,
      plainText,
      centered,
      bold,
      letterSpacing,
      fontSize,
      listItemIndex: null,
    });
  });

  return chunks;
};

const parseFontSize = (style: string): number => {
  const match = style.match(/font-size:\s*(\d+)pt/);
  return match ? Number(match[1]) : 12;
};

// ── Patterns ───────────────────────────────────────────────

/**
 * Lines to skip entirely (decorative/header content).
 * [OBRÁZEK] is always dropped regardless of suffix
 * (e.g. "[OBRÁZEK]ČESKÁ REPUBLIKA" in one <p>).
 */
const SKIP_RE = /^\[OBRÁZEK\]|^pokračování$|^ČESKÁ REPUBLIKA$/;

/** Decision title. */
const TITLE_RE = /^(ROZSUDEK|USNESENÍ|JMÉNEM REPUBLIKY)$/;

/** "takto:" separator. */
const TAKTO_RE = /^t\s*a\s*k\s*t\s*o\s*:?\s*$/i;

/** "Odůvodnění:" separator. */
const ODUVODNENI_RE =
  /^(?:O\s*d\s*ů\s*v\s*o\s*d\s*n\s*ě\s*n\s*í|Odůvodnění)\s*:?\s*$/i;

/** "Poučení:" as standalone or inline prefix. */
const POUCENI_STANDALONE_RE =
  /^(?:P\s*o\s*u\s*č\s*e\s*n\s*í|Poučení)\s*:?\s*$/i;
const POUCENI_INLINE_RE = /^(?:P\s*o\s*u\s*č\s*e\s*n\s*í|Poučení)\s*:\s*/i;

/**
 * Ruling item: Roman numeral + period + text.
 * Only matched in the výrok zone (before Odůvodnění).
 */
const RULING_ITEM_RE = /^((?:X{0,3}(?:IX|IV|V?I{0,3})))\.\s+(.+)/;

/**
 * Section heading in Odůvodnění: Roman numeral + title text.
 * May include sub-headings like "III. A", "III. B".
 */
const SECTION_HEADING_RE =
  /^((?:X{0,3}(?:IX|IV|V?I{0,3})))\.\s*(?:[A-Z]\s+)?[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/;

/** Numbered paragraph: [1], [2], ... */
const NUMBERED_PARA_RE = /^\[(\d+)\]\s*/;

/**
 * Closing line: "V Brně dne ...", "Praha 10. březen 2026",
 * or just "City + date" pattern.
 */
// ── Block classification ───────────────────────────────────

const makeAnchorId = (prefix: string, index: number): string =>
  `${prefix}-${index}`;

/**
 * Strip a character-counted prefix from inlines.
 * Unlike a naive approach, this correctly handles bold,
 * italic, and other wrapper nodes by recursively counting
 * their text content.
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

    // Bold/italic/link: recurse into children
    if ("children" in node) {
      const nodeTextLen = inlinesToPlainText(node.children).length;
      if (nodeTextLen <= remaining) {
        // Entire node consumed by prefix
        remaining -= nodeTextLen;
      } else {
        // Partial strip inside the node
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

const classifyChunks = (chunks: PChunk[]): Block[] => {
  let blockCounter = 0;
  const makeBlockId = (): string => {
    blockCounter += 1;
    return `b${blockCounter}`;
  };
  const blocks: Block[] = [];
  let blockIndex = 0;

  let inOduvodneni = false;
  let inPouceni = false;
  let sawCaseNumber = false;
  let sawTitle = false;

  for (const chunk of chunks) {
    const {
      plainText,
      inlines,
      centered,
      bold,
      letterSpacing: _letterSpacing,
    } = chunk;

    // Skip decorative lines
    if (SKIP_RE.test(plainText)) {
      continue;
    }

    // Case number: first content before the title, centered
    // Case number line (e.g. "2 As 3/2025 - 56")
    if (
      !sawTitle &&
      centered &&
      !TITLE_RE.test(plainText) &&
      !sawCaseNumber &&
      /\d/.test(plainText)
    ) {
      sawCaseNumber = true;
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("p", blockIndex),
        type: "paragraph",
        role: "case-number",
        inlines,
        plainText,
      });
      continue;
    }

    // Decision title: ROZSUDEK, USNESENÍ, JMÉNEM REPUBLIKY
    if (TITLE_RE.test(plainText)) {
      sawTitle = true;
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

    // "takto:" separator (centered, bold, letter-spaced)
    if (TAKTO_RE.test(plainText)) {
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("h", blockIndex),
        type: "heading",
        level: 2,
        role: "section-heading",
        inlines: [{ type: "text", text: "takto:" }],
        plainText: "takto:",
      });
      continue;
    }

    // "Odůvodnění:" separator
    if (ODUVODNENI_RE.test(plainText)) {
      inOduvodneni = true;
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("h", blockIndex),
        type: "heading",
        level: 2,
        role: "section-heading",
        inlines: [{ type: "text", text: "Odůvodnění:" }],
        plainText: "Odůvodnění:",
      });
      continue;
    }

    // "Poučení:" standalone
    if (POUCENI_STANDALONE_RE.test(plainText)) {
      inPouceni = true;
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("h", blockIndex),
        type: "heading",
        level: 2,
        role: "section-heading",
        inlines: [{ type: "text", text: "Poučení:" }],
        plainText: "Poučení:",
      });
      continue;
    }

    // "Poučení:" inline (bold prefix + text in same <p>)
    if (POUCENI_INLINE_RE.test(plainText) && bold) {
      inPouceni = true;
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("h", blockIndex),
        type: "heading",
        level: 2,
        role: "section-heading",
        inlines: [{ type: "text", text: "Poučení:" }],
        plainText: "Poučení:",
      });

      // The rest is the poučení text
      const pouceniMatch = plainText.match(POUCENI_INLINE_RE);
      if (pouceniMatch) {
        const rest = plainText.slice(pouceniMatch[0].length).trim();
        if (rest) {
          blockIndex += 1;
          blocks.push({
            id: makeBlockId(),
            anchorId: makeAnchorId("p", blockIndex),
            type: "paragraph",
            inlines: [{ type: "text", text: rest }],
            plainText: rest,
          });
        }
      }
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

    // Signature: judge title (short, centered lines only)
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

    // Judge name: short centered text right before signature
    // (check next chunk for signature pattern)
    if (
      centered &&
      plainText.length < 60 &&
      !inPouceni &&
      chunks.indexOf(chunk) < chunks.length - 1
    ) {
      const nextChunk = chunks[chunks.indexOf(chunk) + 1];
      if (nextChunk && SIGNATURE_RE.test(nextChunk.plainText)) {
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

    // <ol> list items: holding paragraphs before Odůvodnění,
    // numbered paragraphs after
    if (chunk.listItemIndex !== null) {
      if (!inOduvodneni && !inPouceni) {
        // Reconstruct the full text with Roman numeral prefix
        const roman = `${toRoman(chunk.listItemIndex)}.`;
        const fullInlines: Inline[] = [
          { type: "text", text: `${roman} ` },
          ...inlines,
        ];
        const fullPlain = `${roman} ${plainText}`;
        blockIndex += 1;
        blocks.push({
          id: makeBlockId(),
          anchorId: makeAnchorId("p", blockIndex),
          type: "paragraph",
          role: "holding",
          inlines: fullInlines,
          plainText: fullPlain,
        });
      } else {
        blockIndex += 1;
        blocks.push({
          id: makeBlockId(),
          anchorId: makeAnchorId("p", blockIndex),
          type: "paragraph",
          inlines,
          plainText,
        });
      }
      continue;
    }

    // Ruling items by text pattern (before Odůvodnění):
    // detected by Roman numeral prefix, emitted as holding
    // paragraphs with the full original text preserved.
    if (!inOduvodneni && !inPouceni && RULING_ITEM_RE.test(plainText)) {
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

    // Section headings in Odůvodnění (centered or bold,
    // short, matching Roman numeral pattern)
    if (
      inOduvodneni &&
      !inPouceni &&
      SECTION_HEADING_RE.test(plainText) &&
      plainText.length < 120
    ) {
      blockIndex += 1;
      blocks.push({
        id: makeBlockId(),
        anchorId: makeAnchorId("h", blockIndex),
        type: "heading",
        level: 3,
        inlines,
        plainText,
      });
      continue;
    }

    // Numbered paragraphs: [1], [2], ...
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
            : [{ type: "text", text: strippedText }],
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
