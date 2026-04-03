/**
 * Converts Markdown to a DOCX buffer. The mapping from Markdown
 * elements to DOCX styles is dynamic: the AI chooses which style
 * to assign to each Markdown element via a StyleMapping.
 *
 * Default mapping (Series A cascade):
 *   # → TitleNoSubheading
 *   ## → A_1st Level Numbering (1)
 *   ### → A_2nd Level Numbering (1.1)
 *   #### → A_3rd Level Numbering ((a))
 *   ##### → A_4th Level Numbering ((i))
 *   ###### → A_5th Level Numbering ((1))
 *   paragraph → A1 (indented body)
 *   > blockquote → StockQuote (indented italic)
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { lexer } from "marked";
import type { MarkedToken, Token, Tokens } from "marked";

import { DEFAULT_STYLE_MAPPING } from "./style-guide";
import type { StyleMapping } from "./style-guide";
import { BULLET_HANGING, BULLET_INDENT, stylesConfig } from "./styles";

type DocxChild = Paragraph | Table;

const THIN_BORDER = {
  style: BorderStyle.SINGLE,
  size: 1,
  color: "999999",
};

const TABLE_BORDERS = {
  top: THIN_BORDER,
  bottom: THIN_BORDER,
  left: THIN_BORDER,
  right: THIN_BORDER,
};

type InlineFormat = {
  bold?: boolean;
  italics?: boolean;
};

type KnownTokenType = MarkedToken["type"];

const hasTokenType = <TType extends KnownTokenType>(
  token: Token,
  type: TType,
): token is Extract<MarkedToken, { type: TType }> => token.type === type;

const isStrongToken = (token: Token): token is Tokens.Strong =>
  hasTokenType(token, "strong") && Array.isArray(token.tokens);

const isEmToken = (token: Token): token is Tokens.Em =>
  hasTokenType(token, "em") && Array.isArray(token.tokens);

const isCodespanToken = (token: Token): token is Tokens.Codespan =>
  hasTokenType(token, "codespan") && typeof token.text === "string";

const isLinkToken = (token: Token): token is Tokens.Link =>
  hasTokenType(token, "link") &&
  typeof token.text === "string" &&
  Array.isArray(token.tokens);

const isTextToken = (token: Token): token is Tokens.Text =>
  hasTokenType(token, "text") && typeof token.text === "string";

const isHeadingToken = (token: Token): token is Tokens.Heading =>
  hasTokenType(token, "heading") &&
  typeof token.depth === "number" &&
  Array.isArray(token.tokens);

const isParagraphToken = (token: Token): token is Tokens.Paragraph =>
  hasTokenType(token, "paragraph") && Array.isArray(token.tokens);

const isBlockquoteToken = (token: Token): token is Tokens.Blockquote =>
  hasTokenType(token, "blockquote") && Array.isArray(token.tokens);

const isListToken = (token: Token): token is Tokens.List =>
  hasTokenType(token, "list") && Array.isArray(token.items);

const isTableToken = (token: Token): token is Tokens.Table =>
  hasTokenType(token, "table") &&
  Array.isArray(token.header) &&
  Array.isArray(token.rows);

const isCodeToken = (token: Token): token is Tokens.Code =>
  hasTokenType(token, "code") && typeof token.text === "string";

/**
 * Parse inline tokens (bold, italic, code, links, text) into
 * an array of TextRun elements. The `format` parameter carries
 * inherited formatting from parent nodes (e.g., bold from a
 * strong wrapper).
 */
const parseInlineTokens = (
  tokens: Token[],
  format: InlineFormat = {},
): TextRun[] => {
  const runs: TextRun[] = [];

  for (const token of tokens) {
    if (isStrongToken(token)) {
      runs.push(
        ...parseInlineTokens(token.tokens, {
          ...format,
          bold: true,
        }),
      );
      continue;
    }

    if (isEmToken(token)) {
      runs.push(
        ...parseInlineTokens(token.tokens, {
          ...format,
          italics: true,
        }),
      );
      continue;
    }

    if (isCodespanToken(token)) {
      runs.push(
        new TextRun({
          text: token.text,
          font: "Courier New",
          ...format,
        }),
      );
      continue;
    }

    if (isLinkToken(token)) {
      runs.push(
        new TextRun({
          text: token.text,
          style: "Hyperlink",
          ...format,
        }),
      );
      continue;
    }

    if (isTextToken(token)) {
      runs.push(
        new TextRun({
          text: token.text,
          ...format,
        }),
      );
      continue;
    }

    if ("text" in token && typeof token.text === "string") {
      runs.push(new TextRun({ text: token.text, ...format }));
    }
  }

  return runs;
};

/** Heading depth (1-6) to StyleMapping key. */
const HEADING_KEYS: Record<number, keyof StyleMapping> = {
  1: "h1",
  2: "h2",
  3: "h3",
  4: "h4",
  5: "h5",
  6: "h6",
};

/**
 * Build token-to-docx converters that are closed over a specific
 * StyleMapping. This avoids passing the mapping through every
 * function call.
 */
const createConverters = (mapping: StyleMapping) => {
  const convertHeading = (token: Tokens.Heading): Paragraph => {
    const key = HEADING_KEYS[token.depth];
    const styleId = key ? mapping[key] : mapping.paragraph;

    return new Paragraph({
      style: styleId,
      children: parseInlineTokens(token.tokens),
    });
  };

  const convertBlockquote = (token: Tokens.Blockquote): DocxChild[] =>
    token.tokens.flatMap((inner) => {
      if (isParagraphToken(inner)) {
        return [
          new Paragraph({
            style: mapping.blockquote,
            children: parseInlineTokens(inner.tokens),
          }),
        ];
      }
      return convertToken(inner);
    });

  const convertList = (token: Tokens.List): Paragraph[] => {
    const paragraphs: Paragraph[] = [];

    for (const [i, item] of token.items.entries()) {
      const firstBlock = item.tokens.find(
        (t) => t.type === "text" || t.type === "paragraph",
      );

      const contentRuns =
        firstBlock && "tokens" in firstBlock && Array.isArray(firstBlock.tokens)
          ? parseInlineTokens(firstBlock.tokens)
          : [new TextRun(item.text)];

      const prefix = token.ordered
        ? `${Number(token.start) + i}.\t`
        : "\u2022\t";

      paragraphs.push(
        new Paragraph({
          style: mapping.paragraph,
          indent: {
            left: BULLET_INDENT,
            hanging: BULLET_HANGING,
          },
          children: [new TextRun(prefix), ...contentRuns],
        }),
      );
    }

    return paragraphs;
  };

  const convertTable = (token: Tokens.Table): Table => {
    const headerRow = new TableRow({
      children: token.header.map(
        (cell) =>
          new TableCell({
            borders: TABLE_BORDERS,
            children: [
              new Paragraph({
                children: parseInlineTokens(cell.tokens),
                alignment: AlignmentType.LEFT,
              }),
            ],
          }),
      ),
    });

    const bodyRows = token.rows.map(
      (row) =>
        new TableRow({
          children: row.map(
            (cell) =>
              new TableCell({
                borders: TABLE_BORDERS,
                children: [
                  new Paragraph({
                    children: parseInlineTokens(cell.tokens),
                    alignment: AlignmentType.LEFT,
                  }),
                ],
              }),
          ),
        }),
    );

    return new Table({
      rows: [headerRow, ...bodyRows],
      width: { size: 100, type: WidthType.PERCENTAGE },
    });
  };

  const convertToken = (token: Token): DocxChild[] => {
    if (isHeadingToken(token)) {
      return [convertHeading(token)];
    }

    if (isParagraphToken(token)) {
      return [
        new Paragraph({
          style: mapping.paragraph,
          children: parseInlineTokens(token.tokens),
        }),
      ];
    }

    if (isBlockquoteToken(token)) {
      return convertBlockquote(token);
    }

    if (isListToken(token)) {
      return convertList(token);
    }

    if (isTableToken(token)) {
      return [convertTable(token)];
    }

    if (isCodeToken(token)) {
      return [
        new Paragraph({
          children: [
            new TextRun({
              text: token.text,
              font: "Courier New",
            }),
          ],
        }),
      ];
    }

    if (hasTokenType(token, "hr")) {
      return [
        new Paragraph({
          border: {
            bottom: {
              style: BorderStyle.SINGLE,
              size: 1,
              color: "999999",
            },
          },
        }),
      ];
    }

    if (hasTokenType(token, "space")) {
      return [];
    }

    return [];
  };

  return { convertToken };
};

type MarkdownToDocxOptions = {
  /** AI-chosen mapping from Markdown elements to style IDs.
   *  Defaults to the stock Series A cascade mapping. */
  styleMapping?: StyleMapping;
  /** Path to a reference DOCX template whose styles/numbering
   *  will be injected into the output (XML surgery). */
  templatePath?: string;
  /** BCP-47 language tag (e.g., "en-US", "de-DE"). Defaults to
   *  "en-US". Controls proofing language in the output. */
  lang?: string;
};

/**
 * Convert a Markdown string to a DOCX buffer.
 *
 * The `styleMapping` controls which DOCX style is used for each
 * Markdown element. The AI provides this mapping based on the
 * style guide it receives in its system prompt.
 *
 * If `templatePath` is provided, the output document's styles,
 * numbering, theme, and font table are replaced with those from
 * the template.
 */
export const markdownToDocx = async (
  markdown: string,
  options: MarkdownToDocxOptions = {},
): Promise<Buffer> => {
  const mapping = options.styleMapping ?? DEFAULT_STYLE_MAPPING;
  const { convertToken } = createConverters(mapping);

  const tokens = lexer(markdown);
  const children = tokens.flatMap(convertToken);

  const doc = new Document({
    styles: stylesConfig,
    sections: [{ children }],
  });

  // SAFETY: Packer.toBuffer() returns a Node Buffer in Bun runtime
  let buffer = await Packer.toBuffer(doc);

  if (options.templatePath) {
    const { injectStyles } = await import("./inject-styles");
    buffer = await injectStyles(buffer, options.templatePath, {
      lang: options.lang,
    });
  }

  return buffer;
};
