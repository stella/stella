// parser-output-unchanged: [pl-kio] the shared paragraph helpers keep the same default markers and calculations; only the named argument shape changes for this caller.
/**
 * The procurement database's document pages, read back as the decision set
 * them.
 *
 * orzeczenia.uzp.gov.pl serves every ruling as HTML its converter made from
 * the original. Rulings drafted in Word arrive one paragraph per `<p>`. Older
 * rulings arrive converted from the printed PDF, and keep the print: every
 * printed line ends in a `<br>`, a first line is indented by a padded span,
 * pages are divided by `<hr>` and end on the page number, and an index set in
 * small type (`m²`, `art. 353¹`) is a span of its own in a smaller font. Read
 * as markup, a sentence breaks at every margin, a paragraph that runs over a
 * page splits in two around a stray number, and `1m³` reads `1m 3`.
 *
 * This module rewrites the loaded document in place before the Polish parser
 * walks it, using only what the page states:
 *
 * - a `<br>` the converter set after a printed line joins the two lines when
 *   the first one ran out of room, opens a paragraph where the next line is
 *   indented or opens a list point, and otherwise stays a line break;
 * - a bare number closing a page goes as its page number where the footer's
 *   other evidence stands beside it (see `pageNumbersOf`), and stays
 *   otherwise;
 * - a paragraph cut by a page break with nothing but page furniture between
 *   its parts, or by a block the converter closed with no space after it,
 *   runs on into the next block the same way a line does;
 * - a number of up to three digits in type well below the body's, set
 *   against the word before it, is an index only when its style raises or
 *   lowers it explicitly;
 * - Word's numbering, which the converter prints as a box flush against the
 *   item's text, is followed by a space;
 * - directional marks, which the converter emits with every line break of a
 *   Word original, are removed. Polish text carries none of its own.
 *
 * A Word original's own line breaks are the author's, so they stay: the
 * converter marks each with a left-to-right mark, which is how they are told
 * apart from printed lines before the marks go.
 */

import type { CheerioAPI } from "cheerio";
import { type AnyNode, Element, isTag, isText, Text } from "domhandler";

import {
  parseDecimalToken,
  parseIntegerToken,
} from "@stll/agent-input/numeric-token";
import { normalizeUnicode } from "@stll/text-normalize";

import {
  continuesSentence,
  INDENT_THRESHOLD_PT,
  opensBlockParagraph,
  opensNumberedPoint,
  type PrintedLine,
  ranOutOfRoom,
  takesANumber,
} from "./pl-printed-lines";
import { isExcludedHtmlTag } from "./shared-inlines";

const BIDI_MARK = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const STARTS_WITH_BIDI_MARK = /^[\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** Type at most this share of the body size is set small: an index or a mark. */
const SMALL_TYPE_RATIO = 0.75;

/**
 * What a raised index can be: `2` in `m²`, `1` in `353¹`. A letter in small
 * type is as often lowered (`C` with an index `A`), which the converter does
 * not tell apart, so it stays on the line.
 */
const SUPERSCRIPT_TEXT = /^\d{1,3}$/u;

/** A page number as the converter prints it: the page's last line. */
const MAX_PAGE_NUMBER_DIGITS = 3;

/** Where full justified lines end, read from the longest of them. */
const RIGHT_EDGE_QUANTILE = 0.95;

const WORD_NUMBERING_LABEL = /(?:^|;)\s*display\s*:\s*inline-block/iu;

/**
 * Advance widths of Helvetica, which the converter's Arial matches, in
 * thousandths of the font size. Only relative widths matter: they put each
 * line's end against the document's own right edge.
 */
const GLYPH_WIDTHS: ReadonlyMap<string, number> = new Map([
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    .split("")
    .map(
      (letter, index) =>
        [
          letter,
          [
            667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
            722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
          ][index] ?? 556,
        ] as const,
    ),
  ..."abcdefghijklmnopqrstuvwxyz"
    .split("")
    .map(
      (letter, index) =>
        [
          letter,
          [
            556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
            556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
          ][index] ?? 556,
        ] as const,
    ),
  ..."0123456789".split("").map((digit) => [digit, 556] as const),
  [" ", 278],
  ["!", 278],
  ['"', 355],
  ["%", 889],
  ["&", 667],
  ["'", 191],
  ["(", 333],
  [")", 333],
  ["*", 389],
  ["+", 584],
  [",", 278],
  ["-", 333],
  [".", 278],
  ["/", 278],
  [":", 278],
  [";", 278],
  ["=", 584],
  ["?", 556],
  ["@", 1015],
  ["[", 278],
  ["]", 278],
  ["„", 333],
  ["”", 333],
  ["“", 333],
  ["–", 556],
  ["—", 1000],
  ["…", 1000],
  ["§", 556],
  ["ł", 222],
  ["Ł", 556],
]);

const DEFAULT_GLYPH_WIDTH = 556;

/** The size body text is read at when no element states one. */
const DEFAULT_BODY_SIZE = 11;

const glyphWidth = (character: string): number =>
  GLYPH_WIDTHS.get(character) ??
  GLYPH_WIDTHS.get(normalizeUnicode(character, "NFD").charAt(0)) ??
  DEFAULT_GLYPH_WIDTH;

/**
 * Bold type sets about a tenth wider than regular (Arial Bold against Arial);
 * a bold name ending a line would otherwise read as a line stopping short.
 */
const BOLD_WIDTH_RATIO = 1.1;

type Font = { readonly size: number; readonly bold: boolean };

/** How wide `text` sets in points, before justification stretches it. */
const naturalWidth = (text: string, { size, bold }: Font): number => {
  let total = 0;
  for (const character of text) {
    total += glyphWidth(character);
  }
  return ((total * size) / 1000) * (bold ? BOLD_WIDTH_RATIO : 1);
};

type CssDeclaration = { readonly property: string; readonly value: string };

const cssDeclarations = (style: string): readonly CssDeclaration[] =>
  style.split(";").flatMap((declaration) => {
    const separator = declaration.indexOf(":");
    if (separator === -1) {
      return [];
    }
    return [
      {
        property: declaration.slice(0, separator).trim().toLowerCase(),
        value: declaration.slice(separator + 1).trim(),
      },
    ];
  });

const POINT_SIZE_TOKEN = /^(-?\d+(?:\.\d+)?)pt$/iu;

const pointsToken = (token: string | undefined): number | undefined => {
  if (token === undefined) {
    return undefined;
  }
  const numeric = POINT_SIZE_TOKEN.exec(token)?.at(1);
  return numeric === undefined
    ? undefined
    : parseDecimalToken(numeric).unwrapOr(undefined);
};

const firstPointToken = (value: string): number | undefined =>
  pointsToken(value.trim().split(/\s+/u).at(0));

type FontStyle = {
  readonly size: number | undefined;
  readonly family: string | undefined;
};

/** Read shorthand size and family tokens in one linear declaration scan. */
const fontStyleOf = (style: string): FontStyle => {
  let size: number | undefined;
  let shorthandFamily: string | undefined;
  let explicitFamily: string | undefined;

  for (const { property, value } of cssDeclarations(style)) {
    if (property === "font-family" && explicitFamily === undefined) {
      explicitFamily = value
        .split(",")
        .at(0)
        ?.replace(/["']/gu, "")
        .trim()
        .toLowerCase();
      continue;
    }
    if (property === "font-size" && size === undefined) {
      size = firstPointToken(value);
      continue;
    }
    if (property !== "font") {
      continue;
    }
    const tokens = [...value.matchAll(/\S+/gu)];
    for (const [index, match] of tokens.entries()) {
      const token = match[0];
      const offset = match.index;
      const numericSize = pointsToken(token.split("/", 1).at(0));
      if (numericSize === undefined) {
        continue;
      }
      size ??= numericSize;
      const lineHeightSlash = tokens[index + 1];
      const lineHeight = tokens[index + 2];
      let familyOffset = offset + token.length;
      if (token.endsWith("/") && lineHeightSlash !== undefined) {
        familyOffset = lineHeightSlash.index + lineHeightSlash[0].length;
      } else if (lineHeightSlash?.[0] === "/" && lineHeight !== undefined) {
        familyOffset = lineHeight.index + lineHeight[0].length;
      } else if (lineHeightSlash?.[0].startsWith("/") === true) {
        familyOffset = lineHeightSlash.index + lineHeightSlash[0].length;
      }
      shorthandFamily ??= /^\s+(?<families>[^;]+)/u
        .exec(value.slice(familyOffset))
        ?.groups?.["families"]?.split(",")
        .at(0)
        ?.replace(/["']/gu, "")
        .trim()
        .toLowerCase();
      break;
    }
  }
  return { size, family: explicitFamily ?? shorthandFamily };
};

const styleOf = (element: Element): string => element.attribs["style"] ?? "";

/** The font an element sets its text in, given the one it inherits. */
const fontOf = (element: Element, inherited: Font): Font => {
  const style = styleOf(element);
  const weight = cssDeclarations(style).find(
    ({ property }) => property === "font-weight",
  )?.value;
  let bold = inherited.bold;
  if (element.name === "b" || element.name === "strong") {
    bold = true;
  } else if (weight !== undefined) {
    const normalizedWeight = weight.trim().split(/\s+/u).at(0)?.toLowerCase();
    bold =
      normalizedWeight === "bold" ||
      normalizedWeight === "bolder" ||
      parseDecimalToken(normalizedWeight).unwrapOr(0) >= 600;
  }
  return { size: fontStyleOf(style).size ?? inherited.size, bold };
};

const pointsOf = (style: string, property: string): number | undefined =>
  firstPointToken(
    cssDeclarations(style).find(
      (declaration) => declaration.property === property,
    )?.value ?? "",
  );

/** The four sides of a `padding` shorthand, in points, CSS's order. */
const paddingOf = (
  style: string,
): readonly [number, number, number, number] | undefined => {
  const values = cssDeclarations(style)
    .find((declaration) => declaration.property === "padding")
    ?.value.trim()
    .split(/\s+/u)
    .map((value) => pointsToken(value) ?? 0);
  if (values === undefined) {
    return undefined;
  }
  const [top = 0, right = top, bottom = top, left = right] = values;
  return [top, right, bottom, left];
};

const leftPaddingOf = (style: string): number =>
  pointsOf(style, "padding-left") ?? paddingOf(style)?.[3] ?? 0;

const isBlank = (node: AnyNode): boolean =>
  isText(node) && node.data.trim().length === 0;

const textOf = (node: AnyNode): string => {
  if (isText(node)) {
    return node.data;
  }
  return isTag(node) ? node.children.map(textOf).join("") : "";
};

/** The first family a style names, as a key: `'Arial','sans-serif'` → `arial`. */
const familyOf = (style: string): string | undefined =>
  fontStyleOf(style).family;

/** The size and family a stretch of text is set in, where its markup says. */
type Typeface = {
  readonly size: number | undefined;
  readonly family: string | undefined;
};

/** The typeface an element inherits from its nearest styled ancestors. */
const inheritedTypefaceOf = (element: Element): Typeface => {
  let type: Typeface = { size: undefined, family: undefined };
  let ancestor = element.parent;
  while (
    ancestor !== null &&
    isTag(ancestor) &&
    (type.size === undefined || type.family === undefined)
  ) {
    const style = fontStyleOf(styleOf(ancestor));
    type = {
      size: type.size ?? style.size,
      family: type.family ?? style.family,
    };
    ancestor = ancestor.parent;
  }
  return type;
};

/** Each typeface `root` sets text in, with how many characters it sets. */
const typefacesOf = (
  root: Element,
): Map<string, { type: Typeface; length: number }> => {
  const counted = new Map<string, { type: Typeface; length: number }>();
  const walk = (node: AnyNode, type: Typeface): void => {
    if (isText(node)) {
      const length = node.data.trim().length;
      if (length > 0) {
        const key = `${type.size ?? ""}|${type.family ?? ""}`;
        counted.set(key, {
          type,
          length: (counted.get(key)?.length ?? 0) + length,
        });
      }
      return;
    }
    if (!isTag(node)) {
      return;
    }
    const style = styleOf(node);
    const own = {
      size: fontStyleOf(style).size ?? type.size,
      family: familyOf(style) ?? type.family,
    };
    for (const child of node.children) {
      walk(child, own);
    }
  };
  walk(root, inheritedTypefaceOf(root));
  return counted;
};

/** The typeface most of the text under `root` is set in. */
const bodyTypefaceOf = (root: Element): Typeface => {
  let body: Typeface = { size: undefined, family: undefined };
  let most = 0;
  for (const { type, length } of typefacesOf(root).values()) {
    if (length > most) {
      body = type;
      most = length;
    }
  }
  return body;
};

/** The sibling before `node` that is not whitespace between tags. */
const previousContent = (node: AnyNode): AnyNode | null => {
  let previous = node.prev;
  while (previous !== null && isBlank(previous)) {
    previous = previous.prev;
  }
  return previous;
};

/** The nearest value that `element` or one of its ancestors sets. */
const inheritedStyleValue = (
  element: Element,
  property: string,
): string | undefined => {
  let current: AnyNode | null = element;
  while (current !== null && isTag(current)) {
    const value = cssDeclarations(styleOf(current)).findLast(
      (declaration) => declaration.property === property,
    )?.value;
    if (value !== undefined) {
      return value.trim().toLowerCase();
    }
    current = current.parent;
  }
  return undefined;
};

type IndexPosition = "sub" | "sup";

const SIGNED_CSS_LENGTH = /^(-?\d+(?:\.\d+)?)(?:pt|px|em|rem|%)?$/iu;

const signedCssLength = (value: string | undefined): number | undefined => {
  const numeric =
    value === undefined ? undefined : SIGNED_CSS_LENGTH.exec(value)?.at(1);
  return numeric === undefined
    ? undefined
    : parseDecimalToken(numeric).unwrapOr(undefined);
};

const indexPositionOf = (span: Element): IndexPosition | undefined => {
  const verticalAlign = inheritedStyleValue(span, "vertical-align");
  if (verticalAlign === "sub") {
    return "sub";
  }
  if (verticalAlign === "super") {
    return "sup";
  }
  const baselineShift = signedCssLength(
    inheritedStyleValue(span, "baseline-shift"),
  );
  if (baselineShift === undefined || baselineShift === 0) {
    return undefined;
  }
  return baselineShift > 0 ? "sup" : "sub";
};

const liftSmallTypeIndices = ($: CheerioAPI, bodySize: number): void => {
  $("span").each((_, span) => {
    const size =
      fontStyleOf(styleOf(span)).size ?? inheritedTypefaceOf(span).size;
    const text = textOf(span).trim();
    const position = indexPositionOf(span);
    if (
      size === undefined ||
      size > bodySize * SMALL_TYPE_RATIO ||
      !SUPERSCRIPT_TEXT.test(text) ||
      position === undefined
    ) {
      return;
    }
    const base = previousContent(span);
    if (base === null || !/[\p{L}\d]$/u.test(textOf(base))) {
      return;
    }
    while (span.prev !== null && span.prev !== base) {
      $(span.prev).remove();
    }
    $(span).replaceWith(new Element(position, {}, [new Text(text)]));
  });
};

const spaceWordNumbering = ($: CheerioAPI): void => {
  $("p > span").each((_, span) => {
    if (!WORD_NUMBERING_LABEL.test(styleOf(span))) {
      return;
    }
    let following = "";
    for (let next = span.next; next !== null && following === "";) {
      following = textOf(next);
      next = next.next;
    }
    if (following === "" || /^\s/u.test(following)) {
      return;
    }
    $(span).after(new Text(" "));
  });
};

/**
 * Line breaks that are the author's: the converter writes each break of a
 * Word original as `<br>` followed by a left-to-right mark.
 */
const authorBreaksOf = ($: CheerioAPI): ReadonlySet<Element> =>
  new Set(
    $("br")
      .toArray()
      .filter(
        ({ next }) =>
          next !== null &&
          isText(next) &&
          STARTS_WITH_BIDI_MARK.test(next.data),
      ),
  );

const removeBidiMarks = (node: AnyNode): void => {
  if (isText(node)) {
    node.data = node.data.replace(BIDI_MARK, "");
    return;
  }
  if (isTag(node)) {
    for (const child of node.children) {
      removeBidiMarks(child);
    }
  }
};

type BlockLine = PrintedLine & {
  readonly right: number;
  /** The `<br>` the converter closed this line with; none on a block's last. */
  readonly end: Element | undefined;
};

type Block = {
  readonly element: Element;
  readonly page: number;
  readonly lines: readonly BlockLine[];
  /** Whether a converted print set this block's lines. */
  readonly printed: boolean;
};

type ReadBlockLinesOptions = {
  block: Element;
  bodySize: number;
  authorBreaks: ReadonlySet<Element>;
};

/** A block's printed lines: its text between the `<br>`s the converter set. */
const readBlockLines = ({
  block,
  bodySize,
  authorBreaks,
}: ReadBlockLinesOptions): BlockLine[] => {
  const blockStyle = styleOf(block);
  const blockLeft = leftPaddingOf(blockStyle);
  const firstIndent = pointsOf(blockStyle, "text-indent") ?? 0;
  const lines: BlockLine[] = [];
  let text = "";
  let width = 0;
  let lineIndent: number | undefined;
  const close = (end: Element | undefined): void => {
    const x =
      blockLeft + (lines.length === 0 ? firstIndent : 0) + (lineIndent ?? 0);
    lines.push({
      text: text.replace(/\s+/gu, " ").trim(),
      x,
      right: x + width,
      end,
    });
    text = "";
    width = 0;
    lineIndent = undefined;
  };
  const walk = (node: AnyNode, font: Font): void => {
    if (isText(node)) {
      const data = node.data.replace(/\s+/gu, " ");
      text += data;
      width += naturalWidth(data, font);
      return;
    }
    if (!isTag(node) || isExcludedHtmlTag(node.name)) {
      return;
    }
    if (node.name === "br") {
      if (!authorBreaks.has(node)) {
        close(node);
      }
      return;
    }
    const style = styleOf(node);
    if (lineIndent === undefined && text.trim().length === 0) {
      const padding = pointsOf(style, "padding-left");
      if (padding !== undefined) {
        lineIndent = padding;
      }
    }
    const own = fontOf(node, font);
    for (const child of node.children) {
      walk(child, own);
    }
  };
  const blockFont = fontOf(block, { size: bodySize, bold: false });
  for (const child of block.children) {
    walk(child, blockFont);
  }
  close(undefined);
  return lines;
};

const lastLineIndex = (lines: readonly BlockLine[]): number =>
  lines.findLastIndex(({ text }) => text.length > 0);

/** Where a quantile of the values falls, for a non-empty list. */
const quantileOf = (values: readonly number[], quantile: number): number => {
  const sorted = values.toSorted((left, right) => left - right);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ??
    0
  );
};

/**
 * Whether the converter stated the space after each block itself. Where it
 * did, a block with none after it was cut by the converter, not the author.
 */
const statesBlockSpacing = (blocks: readonly Block[]): boolean =>
  blocks.some(({ element }) => paddingOf(styleOf(element)) !== undefined);

const nextContent = (node: AnyNode): AnyNode | null => {
  let next = node.next;
  while (next !== null && isBlank(next)) {
    next = next.next;
  }
  return next;
};

type Junction = { readonly before: Block; readonly after: Block };

/** Markup that holds text, or stands for content the reader would see. */
const holdsContent = (node: AnyNode): boolean => {
  if (isText(node)) {
    return node.data.trim().length > 0;
  }
  if (!isTag(node)) {
    return false;
  }
  return (
    node.name === "table" ||
    node.name === "img" ||
    node.children.some(holdsContent)
  );
};

/**
 * Whether only page furniture stands between two blocks: the page
 * separator, a page number the reader takes out, and empty markup. A table,
 * a figure or any text between them is content the run-on would jump.
 */
const onlyFurnitureBetween = (
  before: Block,
  after: Block,
  pageNumbers: ReadonlySet<Element>,
): boolean => {
  for (let node = before.element.next; node !== null; node = node.next) {
    if (node === after.element) {
      return true;
    }
    const furniture =
      (isTag(node) && (node.name === "hr" || pageNumbers.has(node))) ||
      !holdsContent(node);
    if (!furniture) {
      return false;
    }
  }
  return false;
};

const junctionsOf = (
  blocks: readonly Block[],
  pageNumbers: ReadonlySet<Element>,
): Junction[] => {
  const spacingStated = statesBlockSpacing(blocks);
  return blocks.slice(1).flatMap((after, index) => {
    const before = blocks[index];
    if (before === undefined) {
      return [];
    }
    const pageBreak =
      after.page !== before.page &&
      onlyFurnitureBetween(before, after, pageNumbers);
    const cutByConverter =
      spacingStated &&
      nextContent(before.element) === after.element &&
      (paddingOf(styleOf(before.element))?.[2] ?? 0) === 0;
    return pageBreak || cutByConverter ? [{ before, after }] : [];
  });
};

const LINE_JOINS = {
  /** The line ran out of room: a space, or nothing after a broken word. */
  JOIN: "join",
  /** The next line opens a paragraph of its own. */
  PARAGRAPH: "paragraph",
  /** The line stopped short: its line break stays. */
  LINE: "line",
} as const;

type LineJoin = (typeof LINE_JOINS)[keyof typeof LINE_JOINS];

/**
 * A point the chamber numbers by outline: `2.1.`, `2.2.1`, or Word's `2.1`
 * label. Its first line hangs left of the text under it.
 */
const OUTLINE_POINT = /^\d{1,3}(?:\.\d{1,3})+\.?\s/u;

/**
 * Where a point's text starts on its first line, so the lines under it hang:
 * a number or a letter in any outline (`2.1.`, `A.`, `b)`), or a bullet.
 */
const POINT_MARKER =
  /^(?:\d{1,3}(?:\.\d{1,3})*[.)]?|[IVXLC]{1,6}[.)]|\p{L}[.)]|[-–•])\s/u;

const opensPoint = (previous: BlockLine, line: BlockLine): boolean =>
  opensNumberedPoint(previous, line) ||
  (OUTLINE_POINT.test(line.text) && !takesANumber(previous.text));

/**
 * How `line` goes on from the line above it.
 *
 * The converter states each line's start, so a first line is one that sits
 * past the line above it, unless that line opens a point and this one hangs
 * under its text. Measured against the page's margin instead, every line of
 * an indented block would read as a first line, and the line ends this reader
 * can only estimate would decide them.
 *
 * A sentence running on across a full line is never cut, whatever indent the
 * converter gave the next line; a point always opens a paragraph. Where the
 * estimate cannot tell, the line break stays.
 */
const joinOf = (
  previous: BlockLine,
  line: BlockLine,
  rightEdge: number,
): LineJoin => {
  if (opensPoint(previous, line)) {
    return LINE_JOINS.PARAGRAPH;
  }
  const full = ranOutOfRoom({ previous, line, rightEdge });
  const runsOn = continuesSentence(previous, line, rightEdge);
  if (full && runsOn) {
    return LINE_JOINS.JOIN;
  }
  const indented =
    line.x - previous.x >= INDENT_THRESHOLD_PT &&
    !POINT_MARKER.test(previous.text);
  if (opensBlockParagraph({ previous, line, indented, rightEdge })) {
    return LINE_JOINS.PARAGRAPH;
  }
  return full || runsOn ? LINE_JOINS.JOIN : LINE_JOINS.LINE;
};

/** A word broken at a hyphen keeps it; the halves join with no space. */
const joinerOf = (previous: BlockLine, line: BlockLine): string =>
  /\p{L}-$/u.test(previous.text) && /^\p{Ll}/u.test(line.text) ? "" : " ";

/** Move everything after `br` into a new block of the same kind, after it. */
const splitAt = ($: CheerioAPI, br: Element): void => {
  const ancestors: Element[] = [];
  let block = br.parent;
  while (block !== null && isTag(block) && block.name !== "p") {
    ancestors.push(block);
    block = block.parent;
  }
  if (block === null || !isTag(block) || block.name !== "p") {
    return;
  }

  let branch: AnyNode = br;
  let moved: AnyNode[] = [];
  for (const ancestor of ancestors) {
    const reopened = new Element(ancestor.name, { ...ancestor.attribs }, []);
    $(reopened).append(
      moved,
      ancestor.children.slice(ancestor.children.indexOf(branch) + 1),
    );
    moved = [reopened];
    branch = ancestor;
  }
  moved.push(...block.children.slice(block.children.indexOf(branch) + 1));
  const opened = new Element("p", { ...block.attribs }, []);
  $(block).after(opened);
  $(opened).append(moved);
  $(br).remove();
};

/** The block's lines, its page number left out. */
const bodyLinesOf = (
  block: Block,
  numbered: ReadonlyMap<Block, string>,
): readonly BlockLine[] =>
  numbered.has(block)
    ? block.lines.slice(0, lastLineIndex(block.lines))
    : block.lines;

const removePageNumber = ($: CheerioAPI, block: Block): void => {
  const index = lastLineIndex(block.lines);
  if (block.lines.every(({ text }, other) => other === index || text === "")) {
    $(block.element).remove();
    return;
  }
  const start = block.lines[index - 1]?.end;
  if (start === undefined || start.parent !== block.element) {
    return;
  }
  let node: AnyNode | null = start;
  while (node !== null) {
    const next: AnyNode | null = node.next;
    $(node).remove();
    node = next;
  }
};

/** A line ending on a word a number belongs to: `art.`, `nr`, `z dnia`. */
const citesANumber = (text: string): boolean =>
  takesANumber(text) || /(?:^|\s)dnia$/iu.test(text.trimEnd());

/** Whether the page separator, or the document's end, follows `block`. */
const closesPage = (block: Block): boolean => {
  const next = nextContent(block.element);
  if (next !== null) {
    return isTag(next) && next.name === "hr";
  }
  const parent = block.element.parent;
  return parent !== null && isTag(parent) && parent.name === "body";
};

type PageNumberCandidate = {
  readonly block: Block;
  readonly value: number;
  /** Whether the number is the block's only line. */
  readonly alone: boolean;
  /** Whether the line above ends on a word the number could belong to. */
  readonly afterCitation: boolean;
};

/**
 * A page's last line that may be its number: a bare number on a line of its
 * own, right before the page separator or the document's end.
 */
const pageNumberCandidateOf = (
  block: Block,
  lineBefore: BlockLine | undefined,
): PageNumberCandidate | undefined => {
  const index = lastLineIndex(block.lines);
  const line = block.lines[index];
  if (
    line === undefined ||
    line.text.length > MAX_PAGE_NUMBER_DIGITS ||
    !closesPage(block)
  ) {
    return undefined;
  }
  const value = parseIntegerToken(line.text, { sign: "unsigned" }).unwrapOr(
    undefined,
  );
  if (value === undefined) {
    return undefined;
  }
  const inBlock = block.lines
    .slice(0, index)
    .findLast(({ text }) => text.length > 0);
  const above = inBlock ?? lineBefore;
  const ownLine =
    inBlock === undefined ||
    block.lines[index - 1]?.end?.parent === block.element;
  if (!ownLine) {
    return undefined;
  }
  return {
    block,
    value,
    alone: inBlock === undefined,
    afterCitation: above !== undefined && citesANumber(above.text),
  };
};

/**
 * How many pages that close on a number agree with this one: each sits as
 * many pages away as the two numbers differ.
 */
const agreeingPagesOf = (
  candidate: PageNumberCandidate,
  candidates: readonly PageNumberCandidate[],
): number =>
  candidates.filter(
    (other) =>
      other !== candidate &&
      other.value - candidate.value === other.block.page - candidate.block.page,
  ).length;

const differsFrom = (type: Typeface, body: Typeface): boolean =>
  type.size !== body.size || type.family !== body.family;

type PageNumbersOptions = {
  blocks: readonly Block[];
  bodyTypeface: Typeface;
};

/**
 * The blocks closing on a page number, which the reader takes out, with
 * the number each closes on.
 *
 * A number closing a page is a page number only with the footer's other
 * evidence beside it. On a paged document it continues the page sequence:
 * another page closes on a number as many pages away as the two numbers
 * differ, and two such pages where the line above ends on a word the number
 * could belong to (`art.`, `nr`, `z dnia`). A document the converter did not
 * page keeps only its last page's footer: a number alone at the very end,
 * after no such word, set in a typeface the body is not. Without that
 * evidence the number stays.
 */
const pageNumbersOf = ({
  blocks,
  bodyTypeface,
}: PageNumbersOptions): Map<Block, string> => {
  const candidates: PageNumberCandidate[] = [];
  let lineBefore: BlockLine | undefined;
  for (const block of blocks) {
    const candidate = pageNumberCandidateOf(block, lineBefore);
    if (candidate !== undefined) {
      candidates.push(candidate);
    }
    lineBefore =
      block.lines.findLast(({ text }) => text.length > 0) ?? lineBefore;
  }
  const paged = blocks.some(({ page }) => page > 0);
  const accepted = candidates.filter((candidate) => {
    if (paged) {
      // After `art.` or `poz.` one agreeing page could be chance; two
      // pin the number to the sequence.
      return (
        agreeingPagesOf(candidate, candidates) >=
        (candidate.afterCitation ? 2 : 1)
      );
    }
    const [footer] = typefacesOf(candidate.block.element).values();
    return (
      candidate.alone &&
      !candidate.afterCitation &&
      candidate.block === blocks.at(-1) &&
      footer !== undefined &&
      differsFrom(footer.type, bodyTypeface)
    );
  });
  return new Map(
    accepted.map(({ block, value }) => [block, String(value)] as const),
  );
};

type ReadLayoutBlocksOptions = {
  bodySize: number;
  authorBreaks: ReadonlySet<Element>;
};

const readLayoutBlocks = (
  $: CheerioAPI,
  { bodySize, authorBreaks }: ReadLayoutBlocksOptions,
): Block[] => {
  let page = 0;
  const blocks: Block[] = [];
  for (const element of $("p, hr").toArray()) {
    if (element.name === "hr") {
      page += 1;
    } else if ($(element).closest("table").length === 0) {
      const lines = readBlockLines({ block: element, bodySize, authorBreaks });
      blocks.push({
        element,
        page,
        lines,
        printed: lines.some(({ end }) => end !== undefined),
      });
    }
  }
  return blocks;
};

type Reflow = {
  merges: { before: Block; after: Block; joiner: string }[];
  breaks: { br: Element; join: LineJoin; joiner: string }[];
};

/** How each printed line, and each block a page or the converter cut, goes on. */
const reflowOf = (
  blocks: readonly Block[],
  numbered: ReadonlyMap<Block, string>,
): Reflow => {
  const textLinesOf = (block: Block): BlockLine[] =>
    bodyLinesOf(block, numbered).filter(({ text }) => text.length > 0);
  const printedLines = blocks
    .filter(({ printed }) => printed)
    .flatMap(textLinesOf);
  if (printedLines.length === 0) {
    return { merges: [], breaks: [] };
  }
  const rightEdge = quantileOf(
    printedLines.map(({ right }) => right),
    RIGHT_EDGE_QUANTILE,
  );
  const withText = blocks.filter((block) => textLinesOf(block).length > 0);
  const removedBlocks = new Set(
    [...numbered.keys()]
      .filter((block) => textLinesOf(block).length === 0)
      .map(({ element }) => element),
  );
  const merges = junctionsOf(withText, removedBlocks).flatMap(
    ({ before, after }) => {
      const above = textLinesOf(before).at(-1);
      const below = textLinesOf(after).at(0);
      return above !== undefined &&
        below !== undefined &&
        joinOf(above, below, rightEdge) === LINE_JOINS.JOIN
        ? [{ before, after, joiner: joinerOf(above, below) }]
        : [];
    },
  );
  const breaks = blocks.flatMap((block) => {
    const lines = bodyLinesOf(block, numbered);
    return lines.slice(1).flatMap((line, index) => {
      const previous = lines[index];
      return previous?.end === undefined ||
        previous.text.length === 0 ||
        line.text.length === 0
        ? []
        : [
            {
              br: previous.end,
              join: joinOf(previous, line, rightEdge),
              joiner: joinerOf(previous, line),
            },
          ];
    });
  });
  return { merges, breaks };
};

/** What the layout reader took out of the document. */
export type PlKioLayoutReading = {
  /** The page numbers removed, in document order. */
  readonly pageNumbers: readonly string[];
};

/**
 * Read the converter's page furniture, printed lines and small type back into
 * the markup the decision states. Mutates `$`.
 */
export const readPlKioLayout = ($: CheerioAPI): PlKioLayoutReading => {
  const body = $("body").get(0);
  if (body === undefined) {
    return { pageNumbers: [] };
  }
  const bodyTypeface = bodyTypefaceOf(body);
  const bodySize = bodyTypeface.size ?? DEFAULT_BODY_SIZE;
  const authorBreaks = authorBreaksOf($);
  removeBidiMarks(body);
  liftSmallTypeIndices($, bodySize);
  spaceWordNumbering($);

  const blocks = readLayoutBlocks($, { bodySize, authorBreaks });
  const numbered = pageNumbersOf({ blocks, bodyTypeface });
  const { merges, breaks } = reflowOf(blocks, numbered);

  for (const block of numbered.keys()) {
    removePageNumber($, block);
  }
  // From the last: a block merged into the one before it brings along the
  // block it absorbed itself.
  for (const { before, after, joiner } of merges.toReversed()) {
    $(before.element).append(new Text(joiner), [...after.element.children]);
    $(after.element).remove();
  }
  for (const { br, join, joiner } of breaks) {
    if (join === LINE_JOINS.JOIN) {
      $(br).replaceWith(new Text(joiner));
    }
  }
  for (const { br, join } of breaks.toReversed()) {
    if (join === LINE_JOINS.PARAGRAPH) {
      splitAt($, br);
    }
  }
  return { pageNumbers: [...numbered.values()] };
};
