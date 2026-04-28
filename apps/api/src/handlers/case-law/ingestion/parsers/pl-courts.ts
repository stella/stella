/**
 * Polish Courts (SAOS) parser.
 *
 * SAOS detail records expose `textContent` either as:
 * - rich HTML with headings, anonymization spans, and links
 * - legacy plaintext for older decisions
 *
 * This parser preserves the available structure and falls back
 * to paragraph-based plaintext parsing when the source has no
 * HTML tags.
 */

import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

import type {
  Block,
  DocumentAst,
  Inline,
  ParagraphRole,
  TableCell,
} from "@/api/handlers/case-law/document-ast";
import { stripHtml } from "@/api/handlers/case-law/ingestion/adapters/utils";
import {
  buildValidationHtml,
  validateAndLog,
} from "@/api/handlers/case-law/ingestion/parsers/validate-ast";
import { sanitizeUrl } from "@/api/lib/sanitize-url";
import { includes } from "@/api/lib/type-guards";

type ParsePlDecisionInput = {
  caseNumber: string;
  ecli: string | undefined;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  sourceUrl: string | undefined;
  documentUrl: string | undefined;
  content: string;
  keywords: string[];
  statutes: string[];
  documentId: string;
};

type ParsePlDecisionOutput = {
  documentAst: DocumentAst;
  fulltext: string;
};

const POLISH_DECISION_TITLE_MAP = {
  wyrok: "WYROK",
  postanowienie: "POSTANOWIENIE",
  uchwała: "UCHWAŁA",
  uzasadnienie: "UZASADNIENIE",
  zarządzenie: "ZARZĄDZENIE",
} as const;
const POLISH_DECISION_TITLE_KEYS = [
  "wyrok",
  "postanowienie",
  "uchwała",
  "uzasadnienie",
  "zarządzenie",
] as const;

const DECISION_TITLES: ReadonlySet<string> = new Set(
  Object.values(POLISH_DECISION_TITLE_MAP),
);
const CASE_NUMBER_RE = /^sygn(?:atura)?\.?\s*akt[:\s]/iu;
const REASONS_HEADING_RE = /^uzasadnienie\b/iu;
// oxlint-disable-next-line sonarjs/slow-regex -- heading check runs against one normalized line, not unbounded document text
const HOLDING_HEADING_RE = /^(?:orzeka|postanawia|uchwala|zarządza)\s*:?\s*$/iu;
const HOLDING_ITEM_RE = /^(?:[IVXLC]+\s*[.)]|[0-9]+\s*[.)]|[a-z][)])\s*/u;
const OPERATIVE_VERB_RE =
  /^(?:oddala|zmienia|uchyla|zasądza|stwierdza|umarza|utrzymuje|nakazuje|odrzuca|ustala|przyznaje|zwraca się|przekazuje|nie obciąża|znosi)\b/iu;
const CLOSING_RE =
  /^[A-ZĄĆĘŁŃÓŚŹŻ][\p{L} .-]+,\s+dnia\s+\d{1,2}\s+\p{L}+\s+\d{4}\s*r?\.?$/u;
const SIGNATURE_RE =
  /^(?:SSA|SSA del\.|SSO|SSR|sędzia|Sędzia|Przewodniczący|Przewodnicząca|Prezes|sprawozdawca)\b/u;

type ParserSection = "preamble" | "holding" | "reasoning";

type ParserState = {
  blocks: Block[];
  blockIndex: number;
  blockIdCounter: number;
  section: ParserSection;
  sawDecisionTitle: boolean;
  decisionTitle: string | undefined;
};

const hasHtmlTags = (content: string): boolean =>
  /<[a-z][\s\S]*>/iu.test(content);

const normalizeWhitespace = (text: string): string =>
  text
    .replace(/\u00a0/g, " ")
    // oxlint-disable-next-line sonarjs/slow-regex -- source text is already split from one court document and replacement is line-local
    .replace(/[ \t]+\n/gu, "\n")
    .trim();

const normalizeLegacyPlainText = (text: string): string =>
  text
    .replace(/\r\n/gu, "\n")
    .replace(/\u00a0/gu, " ")
    .replace(/\t+/gu, " ")
    .split("\n")
    .map((line) => line.replace(/ {2,}/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

const isDecisionTitleText = (text: string): boolean =>
  DECISION_TITLES.has(text.trim().toLocaleUpperCase("pl-PL"));

const normalizeDecisionTitle = (
  decisionType: string | undefined,
): string | undefined => {
  if (!decisionType) {
    return undefined;
  }

  const key = decisionType.toLocaleLowerCase("pl-PL");
  if (includes(POLISH_DECISION_TITLE_KEYS, key)) {
    return POLISH_DECISION_TITLE_MAP[key];
  }
  return undefined;
};

const createState = (): ParserState => ({
  blocks: [],
  blockIndex: 0,
  blockIdCounter: 0,
  section: "preamble",
  sawDecisionTitle: false,
  decisionTitle: undefined,
});

const nextBlockId = (state: ParserState): string => {
  state.blockIdCounter += 1;
  return `b${state.blockIdCounter}`;
};

const pushHeading = (
  state: ParserState,
  level: 1 | 2 | 3,
  plainText: string,
  role: "decision-title" | "section-heading",
  inlines: Inline[],
): void => {
  state.blockIndex += 1;
  state.blocks.push({
    id: nextBlockId(state),
    anchorId: `h-${state.blockIndex}`,
    type: "heading",
    level,
    role,
    inlines,
    plainText,
  });
};

const pushParagraph = (
  state: ParserState,
  plainText: string,
  inlines: Inline[],
  role?: ParagraphRole,
): void => {
  state.blockIndex += 1;
  state.blocks.push({
    id: nextBlockId(state),
    anchorId: `p-${state.blockIndex}`,
    type: "paragraph",
    ...(role && { role }),
    inlines,
    plainText,
  });
};

const pushTable = (
  state: ParserState,
  rows: TableCell[][],
  plainText: string,
): void => {
  state.blockIndex += 1;
  state.blocks.push({
    id: nextBlockId(state),
    anchorId: `t-${state.blockIndex}`,
    type: "table",
    role: "metadata-table",
    rows,
    plainText,
  });
};

const textInline = (text: string, anonymized = false): Inline[] =>
  text
    ? [
        {
          type: "text",
          text,
          ...(anonymized && { anonymized: true as const }),
        },
      ]
    : [];

const appendTextInline = (
  target: Inline[],
  text: string,
  anonymized = false,
): void => {
  if (!text) {
    return;
  }

  const last = target.at(-1);
  if (
    last?.type === "text" &&
    last.anonymized === (anonymized ? true : undefined)
  ) {
    last.text += text;
    return;
  }

  target.push({
    type: "text",
    text,
    ...(anonymized && { anonymized: true as const }),
  });
};

const walkInlines = (
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<AnyNode>,
  anonymized = false,
): Inline[] => {
  const inlines: Inline[] = [];

  el.contents().each((_, node) => {
    // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
    if (node.type === "text") {
      appendTextInline(inlines, $(node).text(), anonymized);
      return;
    }

    // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
    if (node.type !== "tag") {
      return;
    }

    const $node = $(node);
    const tag = node.tagName.toLowerCase();
    const isAnon = anonymized || $node.hasClass("anon-block");

    if (tag === "br") {
      inlines.push({ type: "line-break" });
      return;
    }

    if (tag === "strong" || tag === "b") {
      const children = walkInlines($, $node, isAnon);
      if (children.length > 0) {
        inlines.push({ type: "bold", children });
      }
      return;
    }

    if (tag === "em" || tag === "i") {
      const children = walkInlines($, $node, isAnon);
      if (children.length > 0) {
        inlines.push({ type: "italic", children });
      }
      return;
    }

    if (tag === "a") {
      const children = walkInlines($, $node, isAnon);
      const href = sanitizeUrl($node.attr("href") ?? "");
      if (href && children.length > 0) {
        inlines.push({ type: "link", href, children });
      } else if (children.length > 0) {
        inlines.push(...children);
      }
      return;
    }

    inlines.push(...walkInlines($, $node, isAnon));
  });

  return inlines;
};

const inlinesToPlainText = (inlines: readonly Inline[]): string => {
  let text = "";

  for (const inline of inlines) {
    if (inline.type === "text") {
      text += inline.text;
      continue;
    }

    if (inline.type === "line-break") {
      text += "\n";
      continue;
    }

    text += inlinesToPlainText(inline.children);
  }

  return text;
};

const inferParagraphRole = (
  state: ParserState,
  plainText: string,
  isBold = false,
): ParagraphRole | undefined => {
  if (CASE_NUMBER_RE.test(plainText)) {
    return "case-number";
  }

  if (state.section === "reasoning") {
    if (CLOSING_RE.test(plainText)) {
      return "closing";
    }

    if (plainText.length <= 120 && SIGNATURE_RE.test(plainText)) {
      return "signature";
    }

    return "argumentation";
  }

  if (
    state.section === "holding" ||
    HOLDING_ITEM_RE.test(plainText) ||
    OPERATIVE_VERB_RE.test(plainText)
  ) {
    return "holding";
  }

  if (isBold && state.sawDecisionTitle) {
    return "holding";
  }

  return "intro";
};

const handleHeadingText = (
  state: ParserState,
  plainText: string,
  inlines: Inline[],
): boolean => {
  if (isDecisionTitleText(plainText)) {
    const normalizedPlainText = plainText.trim().toLocaleUpperCase("pl-PL");
    if (
      state.sawDecisionTitle &&
      state.decisionTitle?.trim().toLocaleUpperCase("pl-PL") ===
        normalizedPlainText
    ) {
      if (REASONS_HEADING_RE.test(plainText)) {
        state.section = "reasoning";
      }
      return true;
    }

    if (REASONS_HEADING_RE.test(plainText) && state.sawDecisionTitle) {
      pushHeading(state, 2, plainText, "section-heading", inlines);
      state.section = "reasoning";
      return true;
    }

    pushHeading(state, 1, plainText, "decision-title", inlines);
    state.sawDecisionTitle = true;
    state.decisionTitle = plainText;
    if (REASONS_HEADING_RE.test(plainText)) {
      state.section = "reasoning";
    }
    return true;
  }

  if (REASONS_HEADING_RE.test(plainText)) {
    pushHeading(state, 2, plainText, "section-heading", inlines);
    state.section = "reasoning";
    return true;
  }

  if (HOLDING_HEADING_RE.test(plainText)) {
    pushHeading(state, 2, plainText, "section-heading", inlines);
    state.section = "holding";
    return true;
  }

  return false;
};

const parseParagraphElement = (
  $: cheerio.CheerioAPI,
  state: ParserState,
  node: cheerio.Cheerio<AnyNode>,
): void => {
  const inlines = walkInlines($, node);
  const plainText = normalizeWhitespace(inlinesToPlainText(inlines));

  if (!plainText) {
    return;
  }

  if (handleHeadingText(state, plainText, inlines)) {
    return;
  }

  const role = inferParagraphRole(
    state,
    plainText,
    node.is("strong, b") || node.children("strong, b").length > 0,
  );

  if (role === "holding") {
    state.section = "holding";
  }

  pushParagraph(state, plainText, inlines, role);
};

const parseTableElement = (
  $: cheerio.CheerioAPI,
  state: ParserState,
  node: cheerio.Cheerio<AnyNode>,
): void => {
  const rows: TableCell[][] = [];

  node.find("tr").each((_, row) => {
    const cells: TableCell[] = [];
    $(row)
      .children("th, td")
      .each((__, cell) => {
        const inlines = walkInlines($, $(cell));
        const plainText = normalizeWhitespace(inlinesToPlainText(inlines));
        cells.push({ inlines, plainText });
      });

    if (cells.length > 0) {
      rows.push(cells);
    }
  });

  if (rows.length === 0) {
    return;
  }

  const plainText = rows
    .map((row) => row.map((cell) => cell.plainText).join(" | "))
    .join("\n");
  pushTable(state, rows, plainText);
};

const parseChildren = (
  $: cheerio.CheerioAPI,
  state: ParserState,
  root: cheerio.Cheerio<AnyNode>,
): void => {
  root.contents().each((_, node) => {
    // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
    if (node.type === "text") {
      const text = normalizeWhitespace($(node).text());
      if (!text) {
        return;
      }

      pushParagraph(
        state,
        text,
        textInline(text),
        inferParagraphRole(state, text),
      );
      return;
    }

    // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
    if (node.type !== "tag") {
      return;
    }

    const $node = $(node);
    const tag = node.tagName.toLowerCase();

    if (tag === "p" || tag === "li") {
      parseParagraphElement($, state, $node);
      return;
    }

    if (/^h[1-6]$/u.test(tag)) {
      const inlines = walkInlines($, $node);
      const plainText = normalizeWhitespace(inlinesToPlainText(inlines));
      if (!plainText) {
        return;
      }

      if (handleHeadingText(state, plainText, inlines)) {
        return;
      }

      pushHeading(
        state,
        tag === "h1" || tag === "h2" ? 2 : 3,
        plainText,
        "section-heading",
        inlines,
      );
      return;
    }

    if (tag === "table") {
      parseTableElement($, state, $node);
      return;
    }

    parseChildren($, state, $node);
  });
};

const plainTextParagraphsToInlines = (text: string): Inline[] => {
  const lines = text.split("\n");
  const inlines: Inline[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    appendTextInline(inlines, line);
    if (index < lines.length - 1) {
      inlines.push({ type: "line-break" });
    }
  }

  return inlines;
};

const parsePlainText = (state: ParserState, content: string): void => {
  const paragraphs = content
    .split(/\n{2,}/u)
    .map((paragraph) => normalizeWhitespace(paragraph))
    .filter(Boolean);

  for (const paragraph of paragraphs) {
    const inlines = plainTextParagraphsToInlines(paragraph);

    if (handleHeadingText(state, paragraph, inlines)) {
      continue;
    }

    const role = inferParagraphRole(state, paragraph);
    if (role === "holding") {
      state.section = "holding";
    }

    pushParagraph(state, paragraph, inlines, role);
  }
};

export const parsePlDecisionContent = (
  input: ParsePlDecisionInput,
): ParsePlDecisionOutput => {
  const state = createState();
  const title = normalizeDecisionTitle(input.decisionType);

  if (title) {
    pushHeading(state, 1, title, "decision-title", textInline(title));
    state.sawDecisionTitle = true;
    state.decisionTitle = title;
    if (title === POLISH_DECISION_TITLE_MAP.uzasadnienie) {
      state.section = "reasoning";
    }
  }

  if (hasHtmlTags(input.content)) {
    const $ = cheerio.load(input.content);
    const root = $("body").length > 0 ? $("body") : $.root();
    parseChildren($, state, root);
    validateAndLog("pl-courts", input.caseNumber, input.content, state.blocks);
  } else {
    const normalizedContent = normalizeLegacyPlainText(
      stripHtml(input.content),
    );
    parsePlainText(state, normalizedContent);
    const paragraphs = normalizedContent
      .split(/\n{2,}/u)
      .map((paragraph) => normalizeWhitespace(paragraph))
      .filter(Boolean);
    validateAndLog(
      "pl-courts",
      input.caseNumber,
      buildValidationHtml(paragraphs),
      state.blocks,
    );
  }

  const fulltext = state.blocks
    .map((block) => block.plainText)
    .filter(Boolean)
    .join("\n\n");

  const documentAst: DocumentAst = {
    version: 1,
    source: {
      system: "saos.org.pl",
      documentId: input.documentId,
      webUrl: input.sourceUrl ?? "",
      printUrl: input.documentUrl ?? "",
    },
    metadata: {
      caseNumber: input.caseNumber,
      ecli: input.ecli ?? null,
      court: input.court,
      decisionDate: input.decisionDate ?? null,
      decisionType: input.decisionType ?? null,
      keywords: input.keywords,
      statutes: input.statutes,
    },
    blocks: state.blocks,
  };

  return {
    documentAst,
    fulltext,
  };
};
