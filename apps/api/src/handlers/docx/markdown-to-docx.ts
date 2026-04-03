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
import type { Token, Tokens } from "marked";

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

/**
 * Parse inline tokens (bold, italic, code, links, text) into
 * an array of TextRun elements. The `format` parameter carries
 * inherited formatting from parent nodes (e.g., bold from a
 * strong wrapper).
 */
// SAFETY: token.type discriminates the marked Token union;
// each switch branch narrows to the corresponding Tokens.* subtype.
const parseInlineTokens = (
  tokens: Token[],
  format: InlineFormat = {},
): TextRun[] => {
  const runs: TextRun[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        runs.push(
          // SAFETY: token.type discriminates; branch narrows to Tokens.Strong
          // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
          ...parseInlineTokens((token as Tokens.Strong).tokens, {
            ...format,
            bold: true,
          }),
        );
        break;

      case "em":
        runs.push(
          // SAFETY: token.type discriminates; branch narrows to Tokens.Em
          // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
          ...parseInlineTokens((token as Tokens.Em).tokens, {
            ...format,
            italics: true,
          }),
        );
        break;

      case "codespan":
        runs.push(
          new TextRun({
            // SAFETY: token.type discriminates; branch narrows to Tokens.Codespan
            // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
            text: (token as Tokens.Codespan).text,
            font: "Courier New",
            ...format,
          }),
        );
        break;

      case "link": {
        // SAFETY: token.type discriminates; branch narrows to Tokens.Link
        // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
        const link = token as Tokens.Link;
        runs.push(
          new TextRun({
            text: link.text,
            style: "Hyperlink",
            ...format,
          }),
        );
        break;
      }

      case "text":
        runs.push(
          new TextRun({
            // SAFETY: token.type discriminates; branch narrows to Tokens.Text
            // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
            text: (token as Tokens.Text).text,
            ...format,
          }),
        );
        break;

      default:
        if ("text" in token && typeof token.text === "string") {
          runs.push(new TextRun({ text: token.text, ...format }));
        }
        break;
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
      if (inner.type === "paragraph") {
        return [
          new Paragraph({
            style: mapping.blockquote,
            // SAFETY: inner.type discriminates; branch narrows to Tokens.Paragraph
            // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
            children: parseInlineTokens((inner as Tokens.Paragraph).tokens),
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
        // eslint-disable-next-line typescript-eslint/strict-boolean-expressions
        firstBlock && "tokens" in firstBlock && firstBlock.tokens
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

  // SAFETY: token.type discriminates the marked Token union;
  // each switch branch narrows to the corresponding Tokens.* subtype.
  const convertToken = (token: Token): DocxChild[] => {
    switch (token.type) {
      case "heading":
        // SAFETY: token.type discriminates; branch narrows to Tokens.Heading
        // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
        return [convertHeading(token as Tokens.Heading)];

      case "paragraph":
        return [
          new Paragraph({
            style: mapping.paragraph,
            // SAFETY: token.type discriminates; branch narrows to Tokens.Paragraph
            // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
            children: parseInlineTokens((token as Tokens.Paragraph).tokens),
          }),
        ];

      case "blockquote":
        // SAFETY: token.type discriminates; branch narrows to Tokens.Blockquote
        // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
        return convertBlockquote(token as Tokens.Blockquote);

      case "list":
        // SAFETY: token.type discriminates; branch narrows to Tokens.List
        // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
        return convertList(token as Tokens.List);

      case "table":
        // SAFETY: token.type discriminates; branch narrows to Tokens.Table
        // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
        return [convertTable(token as Tokens.Table)];

      case "code":
        return [
          new Paragraph({
            children: [
              new TextRun({
                // SAFETY: token.type discriminates; branch narrows to Tokens.Code
                // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
                text: (token as Tokens.Code).text,
                font: "Courier New",
              }),
            ],
          }),
        ];

      case "hr":
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

      case "space":
        return [];

      default:
        return [];
    }
  };

  return { convertToken };
};

export type MarkdownToDocxOptions = {
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
