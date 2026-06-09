/**
 * Markdown → DOCX-document import — the inverse of {@link toMarkdown} and the
 * second half of the skills bridge. Parses the GFM subset skill bodies use
 * (headings, paragraphs, bold/italic/strike, inline code, bullet + ordered
 * lists incl. nesting, pipe tables, blockquotes, links) into the docx
 * `Document` model so a skill's markdown can be edited in the Folio editor and
 * re-exported with {@link toMarkdown} without drift.
 *
 * Round-trip notes:
 * - Lists are emitted as real list paragraphs (`listRendering`), so the editor
 *   shows a marker and {@link toMarkdown} re-derives `- ` / `1. ` rather than
 *   leaking a literal bullet glyph into the text.
 * - Inline code uses `Courier New` — a whitelisted monospace family that
 *   {@link toMarkdown} infers back to a backtick span (Folio renders it via its
 *   bundled Cousine substitute).
 * - Markdown carries no page geometry, so the section is flattened to a
 *   continuous, header/footer-free band (a skill body is a document, not a
 *   Word page). Headers/footers live outside `document.content` and are never
 *   produced here.
 */
import { marked, type Token, type Tokens } from "marked";

import type {
  BlockContent,
  Document,
  ListRendering,
  Paragraph,
  Run,
  Table,
  TableCell,
  TableRow,
} from "../types/document";
import { createEmptyDocument } from "../utils/createDocument";

// Whitelisted by toMarkdown's monospace inference, so a codespan survives the
// round-trip. Folio renders Courier New through its bundled Cousine face.
const MONO_FONT = { ascii: "Courier New", hAnsi: "Courier New" } as const;

// marked's `Token` union carries a `Tokens.Generic` member whose `type: string`
// overlaps every literal (and whose `any` index signature absorbs the whole
// union, so `Exclude` can't strip it). A plain `token.type === "x"` guard thus
// narrows to `Tokens.X | Tokens.Generic` and field access stays `any`. This
// predicate maps the discriminator to the concrete token; the runtime type is
// exactly the one the discriminator matched because marked only emits Generic
// for custom extensions, which this lexer setup does not register.
type HandledTokens = {
  blockquote: Tokens.Blockquote;
  code: Tokens.Code;
  codespan: Tokens.Codespan;
  del: Tokens.Del;
  em: Tokens.Em;
  heading: Tokens.Heading;
  link: Tokens.Link;
  list: Tokens.List;
  paragraph: Tokens.Paragraph;
  strong: Tokens.Strong;
  table: Tokens.Table;
  text: Tokens.Text;
};

const isTokenType = <T extends keyof HandledTokens>(
  token: Token,
  type: T,
): token is HandledTokens[T] => token.type === type;

type RunFormat = {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  mono?: boolean;
};

const textRun = (text: string, fmt: RunFormat = {}): Run => {
  const formatting = {
    ...(fmt.bold ? { bold: true } : {}),
    ...(fmt.italic ? { italic: true } : {}),
    ...(fmt.strike ? { strike: true } : {}),
    ...(fmt.mono ? { fontFamily: MONO_FONT } : {}),
  };
  // A Word run can't carry a raw newline — a soft/hard break (e.g. two lines in
  // one blockquote) must be an explicit break node, or the layout engine renders
  // the lines on top of each other. Split on "\n" into text + break content.
  const segments = text.split("\n");
  const content: Run["content"] = [];
  for (const [index, segment] of segments.entries()) {
    if (index > 0) {
      content.push({ type: "break" });
    }
    if (segment.length > 0) {
      content.push({ type: "text", text: segment });
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }
  return { type: "run", formatting, content };
};

const inlineToRuns = (
  tokens: Token[] | undefined,
  fallback: string,
  base: RunFormat,
): Run[] => {
  if (!tokens || tokens.length === 0) {
    return [textRun(fallback, base)];
  }
  const runs: Run[] = [];
  for (const token of tokens) {
    if (isTokenType(token, "strong")) {
      runs.push(
        ...inlineToRuns(token.tokens, token.text, { ...base, bold: true }),
      );
    } else if (isTokenType(token, "em")) {
      runs.push(
        ...inlineToRuns(token.tokens, token.text, { ...base, italic: true }),
      );
    } else if (isTokenType(token, "del")) {
      runs.push(
        ...inlineToRuns(token.tokens, token.text, { ...base, strike: true }),
      );
    } else if (isTokenType(token, "codespan")) {
      runs.push(textRun(token.text, { ...base, mono: true }));
    } else if (isTokenType(token, "link")) {
      runs.push(...inlineToRuns(token.tokens, token.text, base));
    } else if (token.type === "br") {
      runs.push({ type: "run", content: [{ type: "break" }] });
    } else if (isTokenType(token, "text")) {
      const nested = token.tokens;
      if (nested && nested.length > 0) {
        runs.push(...inlineToRuns(nested, token.text, base));
      } else {
        runs.push(textRun(token.text, base));
      }
    } else if ("text" in token && typeof token.text === "string") {
      runs.push(textRun(token.text, base));
    }
  }
  return runs.length > 0 ? runs : [textRun(fallback, base)];
};

const para = (runs: Run[], styleId?: string): Paragraph => ({
  type: "paragraph",
  formatting: styleId ? { styleId } : {},
  content: runs.length > 0 ? runs : [textRun("")],
});

const listPara = (runs: Run[], rendering: ListRendering): Paragraph => ({
  type: "paragraph",
  formatting: {},
  listRendering: rendering,
  content: runs.length > 0 ? runs : [textRun("")],
});

// Header cells are not bolded: in GFM the header is positional (first row + the
// `---` separator), so bolding it would re-export as `**A**` and break the
// round-trip.
const cellOf = (cell: Tokens.TableCell): TableCell => ({
  type: "tableCell",
  content: [para(inlineToRuns(cell.tokens, cell.text, {}))],
});

const tableFromToken = (token: Tokens.Table): Table => ({
  type: "table",
  rows: [
    { type: "tableRow", cells: token.header.map((c) => cellOf(c)) },
    ...token.rows.map(
      (row): TableRow => ({
        type: "tableRow",
        cells: row.map((c) => cellOf(c)),
      }),
    ),
  ],
});

// Real list paragraphs: bullets carry the "•" marker and `isBullet`; ordered
// items carry their computed "N." marker. toMarkdown normalises bullets to "- "
// and preserves the ordered marker, so the markdown round-trips exactly.
const listBlocks = (list: Tokens.List, level: number): BlockContent[] => {
  const out: BlockContent[] = [];
  const start = Number(list.start) || 1;
  for (const [index, item] of list.items.entries()) {
    const rendering: ListRendering = list.ordered
      ? {
          marker: `${start + index}.`,
          level,
          numId: 1,
          isBullet: false,
          numFmt: "decimal",
        }
      : { marker: "•", level, numId: 1, isBullet: true };
    const inlineTokens: Token[] = [];
    const nestedLists: Tokens.List[] = [];
    for (const child of item.tokens) {
      if (isTokenType(child, "list")) {
        nestedLists.push(child);
      } else {
        inlineTokens.push(child);
      }
    }
    out.push(listPara(inlineToRuns(inlineTokens, item.text, {}), rendering));
    for (const nested of nestedLists) {
      out.push(...listBlocks(nested, level + 1));
    }
  }
  return out;
};

const blocksFromTokens = (tokens: Token[] | undefined): BlockContent[] => {
  const blocks: BlockContent[] = [];
  for (const token of tokens ?? []) {
    if (isTokenType(token, "heading")) {
      const level = Math.min(Math.max(token.depth, 1), 4);
      blocks.push(
        para(inlineToRuns(token.tokens, token.text, {}), `Heading${level}`),
      );
    } else if (isTokenType(token, "paragraph")) {
      blocks.push(para(inlineToRuns(token.tokens, token.text, {})));
    } else if (isTokenType(token, "list")) {
      blocks.push(...listBlocks(token, 0));
    } else if (isTokenType(token, "table")) {
      blocks.push(tableFromToken(token));
    } else if (isTokenType(token, "code")) {
      for (const line of token.text.split("\n")) {
        blocks.push(
          para([textRun(line.length > 0 ? line : " ", { mono: true })]),
        );
      }
    } else if (isTokenType(token, "blockquote")) {
      for (const inner of blocksFromTokens(token.tokens)) {
        const styled: BlockContent =
          inner.type === "paragraph"
            ? {
                ...inner,
                formatting: { ...inner.formatting, styleId: "Quote" },
              }
            : inner;
        blocks.push(styled);
      }
    } else if (token.type === "hr") {
      blocks.push(para([textRun("———")]));
    } else if (
      token.type !== "space" &&
      "text" in token &&
      typeof token.text === "string" &&
      token.text.trim().length > 0
    ) {
      blocks.push(para([textRun(token.text)]));
    }
  }
  return blocks;
};

// Markdown has no running header/footer, so flatten that band (content sits
// near the top, no inter-page header/footer gap). The page width and side
// margins stay at the default (Letter, 1" sides) so the editor fits to width
// exactly like the DOCX inspector — the body text fills the panel.
const applyMarkdownPageGeometry = (document: Document): void => {
  const section = document.package.document.finalSectionProperties;
  if (!section) {
    return;
  }
  // A markdown surface has no use for Word's 1-inch print margins; tighten all
  // four to a thin uniform gutter so body text fills the page, and zero the
  // header/footer distances since markdown has no running head/foot.
  section.marginTop = 480;
  section.marginBottom = 480;
  section.marginLeft = 480;
  section.marginRight = 480;
  section.headerDistance = 0;
  section.footerDistance = 0;
};

/**
 * Convert a markdown string to a parsed `Document`. Synchronous. The result is
 * ready to hand to the editor (`<DocxEditor document={…} />`) and to re-export
 * via {@link toMarkdown}.
 */
export function fromMarkdown(markdown: string): Document {
  const document = createEmptyDocument();
  const blocks = blocksFromTokens(marked.lexer(markdown));
  if (blocks.length > 0) {
    document.package.document.content = blocks;
  }
  applyMarkdownPageGeometry(document);
  return document;
}
