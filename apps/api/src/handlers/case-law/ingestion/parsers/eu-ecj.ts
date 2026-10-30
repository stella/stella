// parser-output-unchanged: the lost-content verdict is the same validateAst result; only the logging moved to the pipeline.
// parser-output-unchanged: Whole-document validation reuses the unmodified parsed source; bounded decision subtrees retain serialization and reparsing, so diagnostics and output are unchanged.
/**
 * Court of Justice of the European Union (CJEU) XHTML parser.
 *
 * Converts the Cellar XHTML manifestation of a judgment, order or
 * Advocate General opinion into a canonical DocumentAst.
 *
 * The Cellar XHTML is produced by the Publications Office's
 * `fmx2xhtml` converter and is annotated with a stable `coj-*` class
 * vocabulary that is identical in all 24 official languages. Every
 * decision made here keys off those classes and off the document's
 * own `id="pointN"` paragraph anchors, never off wording, so the same
 * parser handles Bulgarian, Greek and Irish without a language table.
 *
 * The same markup is served both on its own and embedded in a portal
 * page that surrounds it with navigation, contact and footer blocks, so
 * the parse is bounded to the subtree the converter's vocabulary lives
 * in before anything else happens — see `ecjDocumentRoot`.
 *
 * Structure:
 *   p.coj-sum-title-1      leading run: court + date (decision title)
 *                          later:       top-level section headings
 *   p.coj-index            parenthesised keyword chain
 *   p.coj-normal etc.      header block (parties, coram, procedure)
 *   p.coj-title-grseq-N    sub-headings, N = depth
 *   table                  one row: [marker cell | content cell]
 *                          marker p.coj-count#pointN = paragraph number
 *                          marker without an id      = quote/list bullet
 *   hr.coj-note            separator before the footnote list
 *
 * Advocate General opinions carry no dedicated heading class. Their
 * body headings are `p.coj-normal` paragraphs set entirely in bold or
 * italic, with the section marker in its own span; the marker's shape
 * gives the depth.
 *
 * Completeness outranks fidelity throughout. Every classification here
 * is a promotion — a paragraph that is not recognised as a heading is
 * still emitted as a paragraph, and an element the vocabulary does not
 * cover still contributes its text. A decision rendered with the wrong
 * shape is a bad reading experience; a decision missing a paragraph is
 * a wrong answer, and the reader cannot tell that it happened.
 */

import { Result } from "better-result";
import * as cheerio from "cheerio";
import { type AnyNode, type Element, isTag, isText } from "domhandler";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
// parser-output-unchanged: imports the document AST from its package owner
import type {
  Block,
  DocumentAst,
  HeadingBlock,
  Inline,
  ParagraphBlock,
  ParagraphRole,
} from "@stll/legal-ast/document-ast";
import { hasInlineChildren } from "@stll/legal-ast/document-ast";
import {
  normalizeInlineLine,
  stripInlineLinePrefix,
} from "@stll/legal-ast/inline-line";

import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";
import { sanitizeUrl } from "@/api/lib/sanitize-url";

import {
  ANONYMIZED_CLASS,
  appendTextInline,
  inlinesToPlainText,
  ownTableRows,
  visibleHtmlText,
  walkInlines,
  type WalkInlinesOptions,
} from "./shared-inlines";

// ── Public API ─────────────────────────────────────────────

export type ParseEcjDecisionInput = {
  caseNumber: string;
  ecli: string | undefined;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  /** Human-facing EUR-Lex URL for the decision. */
  sourceUrl: string | undefined;
  /**
   * Language of this variant. A CJEU case number identifies up to 24
   * documents, so a diagnostic log without it cannot be acted on.
   */
  language?: string | undefined;
  /** CELEX number, used as the AST document id. */
  celex: string;
  /** Cellar XHTML manifestation. */
  html: string;
};

export type ParseEcjDecisionOutput = {
  documentAst: DocumentAst;
  fulltext: string;
  /** Keyword chain from the `coj-index` line, one entry per segment. */
  keywords: string[];
  /**
   * What bounded the parse. A caller storing the result needs it:
   * `document` says the response carried none of the converter's
   * vocabulary, so whatever the walk emitted came from a page rather
   * than from the Court's own output.
   */
  boundary: EcjDocumentBoundary;
  /**
   * Codes of the issues `validateAst` found, empty on a clean parse. The
   * adapter falls back to the stripped text on lost content, and tests
   * assert on retention without re-walking the source document.
   */
  validationIssues: string[];
};

export const parseEcjDecisionHtml = (
  input: ParseEcjDecisionInput,
): ParseEcjDecisionOutput => {
  const $ = cheerio.load(input.html);
  const { boundary, root: $document } = ecjDocumentRoot($);
  const blocks = buildBlocks($, $document);
  const keywords = extractKeywords($document);

  const validationHtml = documentSource($, $document, input.html);
  // Measured, not logged: the adapter uses the verdict to fall back to the
  // stripped text, and the pipeline reports retention for what is stored.
  const validation = validateAst(
    validationHtml,
    blocks,
    tagNameOf($document.get(0)) === "body" ? { document: $ } : undefined,
  );

  return {
    documentAst: {
      version: 1,
      source: {
        system: "cellar.publications.europa.eu",
        documentId: input.celex,
        webUrl: input.sourceUrl ?? "",
        printUrl: "",
      },
      metadata: {
        caseNumber: input.caseNumber,
        ecli: input.ecli ?? null,
        court: input.court,
        decisionDate: input.decisionDate ?? null,
        decisionType: input.decisionType ?? null,
        keywords,
        statutes: [],
      },
      blocks,
    },
    fulltext: toFulltext(blocks),
    keywords,
    boundary,
    validationIssues: validation.issues.map((issue) => issue.code),
  };
};

/**
 * Render the AST back to plain text. Paragraph numbers are re-attached
 * here because search, citation extraction and the AI pipeline all read
 * `fulltext` and CJEU case law is cited by paragraph number.
 */
const toFulltext = (blocks: readonly Block[]): string => {
  const lines: string[] = [];
  for (const block of blocks) {
    const text = block.plainText.trim();
    if (!text) {
      continue;
    }
    const number =
      block.type === "paragraph" && block.number !== undefined
        ? `${block.number} `
        : "";
    lines.push(`${number}${text}`);
  }
  return lines.join("\n\n");
};

// ── Class vocabulary ───────────────────────────────────────

/**
 * Class vocabulary, written unprefixed.
 *
 * The Publications Office renamed these classes when its converter
 * moved to version 9: documents generated before that carry `normal`,
 * `count`, `sum-title-1`, and documents generated after carry
 * `coj-normal`, `coj-count`, `coj-sum-title-1`. Nothing else about the
 * markup changed, and both forms are served today — the prefix follows
 * when the document was converted, not when it was decided. Class
 * lookups here strip the prefix so one vocabulary covers both.
 */
const CLASS = {
  bold: "bold",
  italic: "italic",
  /** Ordinary body paragraph, inside a row cell or standing alone. */
  normal: "normal",
  /** Decision title lines and top-level section headings. */
  title: "sum-title-1",
  /** Parenthesised keyword chain under the title. */
  index: "index",
  /** Marker cell of a two-column row (paragraph number, bullet, quote). */
  count: "count",
  /** Footnote separator and footnote bodies. */
  note: "note",
} as const;

const CLASS_PREFIX = "coj-";

/** Selector matching a class in either converter's spelling. */
const sel = (name: string): string => `.${CLASS_PREFIX}${name}, .${name}`;

/** Sub-heading depth, e.g. `coj-title-grseq-2`. */
const GRSEQ_CLASS = /^title-grseq-(?<depth>\d+)$/u;
/** Signature block wrappers: `signaturecase`, `signatory3left`, … */
const SIGNATURE_CLASS_PREFIX = "signat";
/** Publisher paragraph anchor, e.g. `id="point42"`. */
const POINT_ID = /^point(?<number>\d+)$/u;

// ── Document boundary ──────────────────────────────────────

/**
 * Classes that only ever sit on converter output. Every decision the
 * Court publishes carries several of them: a title line, a keyword
 * chain, a marker cell, a body paragraph.
 */
const DOCUMENT_MARKER_CLASSES = [
  CLASS.title,
  CLASS.index,
  CLASS.count,
  CLASS.normal,
] as const;

const classSelector = (prefix: string): string =>
  DOCUMENT_MARKER_CLASSES.map((name) => `.${prefix}${name}`).join(", ");

/** The oldest layout's wrapper, the only structure it annotates. */
const LEGACY_DOCUMENT_CONTAINER = "div.texte";

/**
 * Selectors that mark converter output, most specific first.
 *
 * A document is converted once and so carries one spelling throughout,
 * which is why these are tried in order rather than unioned: the
 * prefixed vocabulary belongs to the converter alone and cannot be
 * confused with a hosting page's own markup, so it decides the boundary
 * whenever it is present. The last entry covers the oldest layout,
 * which puts no classes on its paragraphs at all and instead wraps the
 * whole decision in one container.
 */
const DOCUMENT_MARKER_SELECTORS = [
  classSelector(CLASS_PREFIX),
  classSelector(""),
  LEGACY_DOCUMENT_CONTAINER,
] as const;

/** Ancestor chain of a node, outermost first, the node itself last. */
const ancestorChain = (node: AnyNode): AnyNode[] => {
  const chain: AnyNode[] = [];
  for (let current: AnyNode | null = node; current; current = current.parent) {
    chain.unshift(current);
  }
  return chain;
};

/** Deepest element that contains every one of `nodes`. */
const commonAncestor = (nodes: readonly Element[]): Element | undefined => {
  let chain = nodes[0] === undefined ? [] : ancestorChain(nodes[0]);
  for (const node of nodes.slice(1)) {
    const other = ancestorChain(node);
    let depth = 0;
    while (
      depth < chain.length &&
      depth < other.length &&
      chain[depth] === other[depth]
    ) {
      depth += 1;
    }
    chain = chain.slice(0, depth);
  }
  const deepest = chain.at(-1);
  // The chain bottoms out at the document node, which is not an
  // element and cannot be walked as one.
  return deepest !== undefined && isTag(deepest) ? deepest : undefined;
};

/**
 * A parse boundary, and what the boundary was read off.
 *
 * `converter` bounds the decision by the source's own markers.
 * `document` is the fallback to `<body>`, which says the response held
 * no marker at all — a distinction the caller has to make, since it
 * separates a layout the parser does not recognise from a page that is
 * not converter output in the first place.
 */
export type EcjDocumentRoot =
  | { boundary: "converter"; root: cheerio.Cheerio<AnyNode> }
  | { boundary: "document"; root: cheerio.Cheerio<AnyNode> }
  | { boundary: "page-chrome"; root: cheerio.Cheerio<AnyNode> };

type EcjDocumentBoundary = EcjDocumentRoot["boundary"];

/**
 * Class prefix of the Europa Component Library, the design system every
 * europa.eu site is built from.
 *
 * It is the publisher's own annotation for its own furniture — header,
 * language selector, cookie banner, contact block, footer — and it is
 * spelled the same in all 24 languages, which a phrase list could never
 * be. A converter manifestation carries none of it: the converter emits
 * the document and nothing around it.
 */
const CHROME_CLASS_PREFIX = "ecl-";

/**
 * Whether the page is built out of the publisher's component library.
 *
 * Read off class tokens rather than off any text, and confirmed token by
 * token: an attribute substring match would also accept a class that
 * merely contains the prefix.
 */
export const ecjPageCarriesChrome = ($: cheerio.CheerioAPI): boolean =>
  $(`[class*="${CHROME_CLASS_PREFIX}"]`)
    .toArray()
    .some((element) =>
      ($(element).attr("class") ?? "")
        .split(/\s+/u)
        .some((token) => token.startsWith(CHROME_CLASS_PREFIX)),
    );

/**
 * The subtree holding the decision.
 *
 * A manifestation served on its own is the decision and nothing else,
 * so this is its `<body>`. The same markup is also published embedded
 * in a portal page, where the decision is one panel among navigation,
 * contact and footer blocks that are the site's, not the Court's. Those
 * blocks are not document text at all, so they are excluded by a
 * boundary rather than by recognising what they say: the decision is
 * the deepest element containing every one of the converter's own
 * marker elements, and page furniture is by construction outside it.
 *
 * Reading the boundary off the converter's vocabulary keeps this
 * working in all 24 languages, where a wording-based rule would hold in
 * one. Where no marker is found the whole body is the document, so an
 * unrecognised layout still contributes all of its text.
 *
 * A missing marker on its own says only that: unmatched. It becomes
 * `page-chrome` — a page served where a decision would be — when the
 * body is additionally built out of the publisher's component library,
 * which converter output never is. Both signals are the publisher's own
 * annotations, and a caller storing text needs the pair: one selector
 * that stopped matching must not turn a decision into a page.
 */
export const ecjDocumentRoot = ($: cheerio.CheerioAPI): EcjDocumentRoot => {
  const $body = $("body");
  for (const selector of DOCUMENT_MARKER_SELECTORS) {
    const marked = $body.find(selector).toArray();
    const ancestor = commonAncestor(marked);
    if (ancestor === undefined) {
      continue;
    }
    // The oldest layout annotates nothing but its own wrapper, so its
    // single marker is its own common ancestor and the decision is that
    // wrapper's container. Every other layout marks the paragraphs, and
    // a marked element that contains the rest is already the boundary:
    // promoting past it would step back out into the carrying page.
    const parent = ancestor.parent;
    if (
      selector === LEGACY_DOCUMENT_CONTAINER &&
      marked.length === 1 &&
      marked.at(0) === ancestor &&
      parent !== null &&
      isTag(parent)
    ) {
      return { boundary: "converter", root: $(parent) };
    }
    return { boundary: "converter", root: $(ancestor) };
  }
  return ecjPageCarriesChrome($)
    ? { boundary: "page-chrome", root: $body }
    : { boundary: "document", root: $body };
};

/**
 * Source text the AST is measured against: the decision, not the page
 * that carried it. Measuring against the page would read the furniture
 * the boundary excluded as lost content, and send a correct parse down
 * the caller's fallback path.
 *
 * Serializing is skipped when the decision is the whole body, which is
 * what a manifestation served on its own looks like.
 */
const documentSource = (
  $: cheerio.CheerioAPI,
  $document: cheerio.Cheerio<AnyNode>,
  html: string,
): string =>
  tagNameOf($document.get(0)) === "body" ? html : $.html($document);

/** The decision's markup, and what bounded it. */
export type EcjDocumentSource = {
  boundary: EcjDocumentBoundary;
  html: string;
};

/**
 * The converter that produced this manifestation, from the comment it leaves
 * above the document.
 *
 * It is what tells the `coj-`prefixed class vocabulary apart from the
 * unprefixed one the pre-version-9 pipeline emitted, so a row that carries it
 * states which of the two layouts its parse was of.
 */
const CONVERTER_COMMENT =
  /<!--\s*fmx2xhtml\s*#\s*converter_version:(?<version>[^\s#]+)/u;

export const ecjConverterVersion = (html: string): string | undefined =>
  CONVERTER_COMMENT.exec(html)?.groups?.["version"];

/**
 * The decision's own markup, lifted out of whatever page carried it.
 *
 * For callers that need the source text without a parse, so that a
 * fallback path keeps the same boundary a successful parse would have —
 * including the case where there was no marker to bound it by, which
 * the caller must be able to tell apart from a bounded document.
 */
export const ecjDocumentHtml = (html: string): EcjDocumentSource => {
  const $ = cheerio.load(html);
  const document = ecjDocumentRoot($);
  return {
    boundary: document.boundary,
    html: documentSource($, document.root, html),
  };
};

/** Semantic heading tags, mapped onto the AST's three levels. */
const HEADING_TAGS: Record<string, 1 | 2 | 3 | undefined> = {
  h1: 1,
  h2: 1,
  h3: 2,
  h4: 3,
  h5: 3,
  h6: 3,
};

const HEADING_LEVELS = [1, 2, 3] as const;
type HeadingLevel = (typeof HEADING_LEVELS)[number];

const toHeadingLevel = (depth: number): HeadingLevel =>
  HEADING_LEVELS.find((level) => level === depth) ?? 3;

const classDepth = (
  classNames: readonly string[],
  pattern: RegExp,
): number | undefined => {
  for (const name of classNames) {
    const depth = pattern.exec(name)?.groups?.["depth"];
    if (depth !== undefined) {
      return Number.parseInt(depth, 10);
    }
  }
  return undefined;
};

// ── Inline walking ─────────────────────────────────────────

/**
 * Cellar XHTML carries emphasis on classed `<span>`s and uses `<a>`
 * both for external ECLI/OJ references and for intra-document footnote
 * anchors. `sanitizeUrl` keeps the former (http/https) and flattens the
 * latter (`#fragment`) to text, which is what the reader wants: the
 * footnote targets are not part of the AST.
 */
const ECJ_INLINE_OPTIONS = {
  sanitizeHref: sanitizeUrl,
  emphasisClasses: {
    bold: [CLASS.bold, `${CLASS_PREFIX}${CLASS.bold}`],
    italic: [CLASS.italic, `${CLASS_PREFIX}${CLASS.italic}`],
  },
};

const walkEcjInlines = (
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<AnyNode>,
  options: WalkInlinesOptions = ECJ_INLINE_OPTIONS,
): Inline[] => collapseWhitespace(walkInlines($, el, options));

/**
 * The converter pretty-prints its output, so inline text arrives with
 * the source's indentation newlines and tabs inside it, and CJEU text
 * is dense with non-breaking spaces ("Article 267"). Collapse every
 * whitespace run to one plain space and trim the paragraph's outer
 * edges; explicit `<br/>` breaks survive as `line-break` inlines.
 */
const collapseWhitespace = (inlines: readonly Inline[]): Inline[] => {
  const mapped = inlines.map((node): Inline => {
    if (node.type === "text") {
      return { ...node, text: node.text.replace(/\s+/gu, " ") };
    }
    if (!hasInlineChildren(node)) {
      return node;
    }
    return { ...node, children: collapseWhitespace(node.children) };
  });

  trimEdge(mapped, "start");
  trimEdge(mapped, "end");
  return mapped.filter((node) => node.type !== "text" || node.text !== "");
};

/** Trim the outermost text of an inline list, descending into wrappers. */
const trimEdge = (inlines: Inline[], edge: "start" | "end"): void => {
  const index = edge === "start" ? 0 : inlines.length - 1;
  const node = inlines[index];
  if (node === undefined) {
    return;
  }
  if (node.type === "text") {
    inlines[index] = {
      ...node,
      text: edge === "start" ? node.text.trimStart() : node.text.trimEnd(),
    };
    return;
  }
  if (hasInlineChildren(node)) {
    trimEdge(node.children, edge);
  }
};

const textOf = (el: cheerio.Cheerio<AnyNode>): string =>
  visibleHtmlText(el).replace(/\s+/gu, " ").trim();

// ── Keywords ───────────────────────────────────────────────

/**
 * Chain delimiters are language-specific: parentheses in English and
 * French, guillemets in Greek, low/high quotes in German and Bulgarian
 * (`„…“`, whose closer is an *initial* quote in Unicode). Strip the
 * bracket and quote classes from both ends rather than enumerating
 * pairs or trusting their directionality. Exactly one character at
 * each end: a keyword can itself end in a bracket ("Article 7(1)(e)(ii)
 * of Regulation No 40/94") and only the outermost one is the chain's.
 */
const CHAIN_DELIMITERS =
  /^[\p{Ps}\p{Pe}\p{Pi}\p{Pf}]|[\p{Ps}\p{Pe}\p{Pi}\p{Pf}]$/gu;

/**
 * Keyword separator: a non-breaking space, an en or em dash, then an
 * ordinary space. The trailing space must not be non-breaking — that
 * form ("Regula (ES) 2016/679 – 2. panta 2. punkts" in Latvian) is a
 * dash *inside* one keyword, and splitting on it would invent a
 * keyword boundary the court did not draw.
 */
const KEYWORD_SEPARATOR = /\u00a0[–—] /u;

/** Fallback for documents whose separator carries ordinary spaces. */
const LOOSE_KEYWORD_SEPARATOR = /\s[–—]\s/u;

/**
 * The `coj-index` line is a bracketed chain of subject-matter keywords,
 * the same list the publisher marks up as `INDEX/KEYWORD` in Formex.
 */
const extractKeywords = ($document: cheerio.Cheerio<AnyNode>): string[] => {
  // Read the raw text rather than `textOf`: the separator is defined by
  // its exact spacing, which whitespace collapsing would destroy.
  const raw = visibleHtmlText($document.find(sel(CLASS.index)).first()).trim();
  if (!raw) {
    return [];
  }
  const inner = raw.replace(CHAIN_DELIMITERS, "");
  const separator = KEYWORD_SEPARATOR.test(inner)
    ? KEYWORD_SEPARATOR
    : LOOSE_KEYWORD_SEPARATOR;

  return inner
    .split(separator)
    .map((part) => part.replace(/\s+/gu, " ").trim())
    .filter((part) => part.length > 0);
};

/**
 * Whether a normalized historical payload lost spacing that determines ECJ
 * keyword boundaries. The old sourceRaw path converted NBSP to ordinary
 * spaces before upload; once that has happened, a loose space-dash-space in
 * the keyword chain can be either a separator or part of one Latvian keyword.
 */
/**
 * Whether this manifestation carries a keyword chain at all.
 *
 * Both spellings of the class, because an inventory that asked only about the
 * modern one would declare every pre-version-9 document as stating no
 * keywords while the parser reads them.
 */
export const ecjStatesKeywordChain = (html: string): boolean =>
  new RegExp(`class="(?:${CLASS_PREFIX})?${CLASS.index}"`, "u").test(html);

export const ecjKeywordSpacingNeedsVerbatim = (html: string): boolean => {
  const $ = cheerio.load(html);
  const raw = visibleHtmlText($(sel(CLASS.index)).first()).trim();
  return (
    raw.length > 0 &&
    !KEYWORD_SEPARATOR.test(raw) &&
    LOOSE_KEYWORD_SEPARATOR.test(raw)
  );
};

// ── Block building ─────────────────────────────────────────

type Zone = "header" | "body" | "operative" | "footnotes";

/**
 * Which of the publisher's two markups the document is in.
 *
 * `classed` is converter output: the class vocabulary, marker cells with
 * `pointN` anchors. `legacy` is the oldest layout, `div.listNotice >
 * div.texte`, which carries none of that: its paragraphs are bare `<p>`s
 * with the number printed as text, and its sections are named only by the
 * publisher's anchors (`<a name="MO"/>`).
 */
type Layout = "classed" | "legacy";

type BlockBuilder = {
  blocks: Block[];
  /** Sequence number for blocks without a publisher anchor. */
  sequence: number;
  /** Monotonic id counter, independent of anchor naming. */
  counter: number;
  zone: Zone;
  /** True while no block other than a title line has been emitted. */
  inTitleRun: boolean;
  layout: Layout;
  /**
   * Whether the document's `pointN` anchors number its paragraphs. They
   * do unless an id repeats: a decision whose operative part and summary
   * each count from 1 holds lists, and a number that names two passages
   * names none of them.
   */
  pointsAreNumbering: boolean;
  /** How this walk treats numbers the oldest layout prints. */
  printedNumbers: PrintedNumbering;
  /** A printed report page marker waiting for the block it precedes. */
  pendingPage: string | undefined;
};

/**
 * A number printed at the start of one of the oldest layout's paragraphs,
 * which may be the Court's numbering or may not: a quoted list item, a
 * date, an amount.
 */
type PrintedNumberCandidate = {
  /** The paragraph's position among the walked elements. */
  index: number;
  number: number;
  /** `2. Text` is dotted; `2 Text` and `2TEXT` are bare. */
  marker: "dotted" | "bare";
  /** The text after the number reads as a month and a year (`1 May 2000`). */
  dated: boolean;
};

/**
 * Which printed numbers are the Court's can only be told from the whole
 * sequence, so the oldest layout is walked twice: a `survey` collects every
 * candidate, and the `settled` walk numbers the paragraphs at the positions
 * `settlePrintedNumbers` chose.
 */
type PrintedNumbering =
  | { type: "survey"; candidates: PrintedNumberCandidate[] }
  | { type: "settled"; numbers: ReadonlyMap<number, number> };

const nextId = (builder: BlockBuilder): string => {
  builder.counter += 1;
  return `b${builder.counter}`;
};

const nextAnchor = (builder: BlockBuilder, prefix: string): string => {
  builder.sequence += 1;
  return `${prefix}-${builder.sequence}`;
};

/**
 * Roles are derived from position, never from wording. The zones a CJEU
 * document goes through are: header (up to the first numbered
 * paragraph), body, operative part (after the last numbered paragraph)
 * and the footnote list. `role` is omitted rather than set to
 * `"unknown"` so the reader falls back to plain body styling.
 */
const roleOf = (zone: Zone, signature = false): { role?: ParagraphRole } => {
  if (signature) {
    return { role: "signature" };
  }
  if (zone === "header") {
    return { role: "intro" };
  }
  if (zone === "operative") {
    return { role: "holding" };
  }
  return {};
};

/**
 * The block's inlines with a waiting page marker in front. The marker is
 * zero-width on the text axis, so the plain text is unchanged.
 */
const withPendingPage = (
  builder: BlockBuilder,
  inlines: Inline[],
): Inline[] => {
  const page = builder.pendingPage;
  if (page === undefined) {
    return inlines;
  }
  builder.pendingPage = undefined;
  return [{ type: "page-anchor", label: page }, ...inlines];
};

const pushHeading = (
  builder: BlockBuilder,
  heading: Omit<HeadingBlock, "id" | "anchorId" | "type">,
): void => {
  builder.blocks.push({
    id: nextId(builder),
    anchorId: nextAnchor(builder, "h"),
    type: "heading",
    ...heading,
    inlines: withPendingPage(builder, heading.inlines),
  });
};

const pushParagraph = (
  builder: BlockBuilder,
  paragraph: Omit<ParagraphBlock, "id" | "anchorId" | "type"> & {
    anchorId?: string;
  },
): void => {
  const { anchorId, ...rest } = paragraph;
  builder.blocks.push({
    id: nextId(builder),
    anchorId: anchorId ?? nextAnchor(builder, "p"),
    type: "paragraph",
    ...rest,
    inlines: withPendingPage(builder, rest.inlines),
  });
};

/**
 * Expand block containers into the element list, depth first.
 *
 * The Publications Office's oldest XHTML wraps a whole decision in
 * `div.listNotice > div.texte`. Walking those wrappers in place would
 * give every element inside them the wrapper's own position, and
 * position is what separates the operative part from the body — so the
 * document is flattened first and every element gets a real one.
 */
const flattenChildren = (
  $: cheerio.CheerioAPI,
  elements: readonly AnyNode[],
): AnyNode[] => {
  const flat: AnyNode[] = [];
  for (const element of elements) {
    const $element = $(element);
    if (isTag(element) && $element.children("p, div, table").length > 0) {
      // The oldest layout's section anchors are written `<a name="MO"/>`,
      // which an HTML parser reads as an open `<a>` holding the whole
      // section. The anchor is kept ahead of its contents, as the marker
      // that opens the section, and the contents are walked as usual.
      if (sectionAnchorZone(element) !== undefined) {
        flat.push(element);
      }
      flat.push(...flattenChildren($, $element.contents().toArray()));
      continue;
    }
    flat.push(element);
  }
  return flat;
};

const buildBlocks = (
  $: cheerio.CheerioAPI,
  $document: cheerio.Cheerio<AnyNode>,
): Block[] => {
  const children = flattenChildren($, $document.contents().toArray());
  const pointIds = $document
    .find(sel(CLASS.count))
    .toArray()
    .flatMap((marker) => {
      const id = $(marker).attr("id") ?? "";
      return POINT_ID.test(id) ? [id] : [];
    });
  const layout =
    $document.find(LEGACY_DOCUMENT_CONTAINER).length > 0 ? "legacy" : "classed";
  const pointsAreNumbering = new Set(pointIds).size === pointIds.length;

  // The operative part is everything between the last numbered
  // paragraph and the signature/footnote tail. Locating its start needs
  // a look-ahead, so resolve it before the forward walk.
  const lastPointIndex = pointsAreNumbering
    ? children.findLastIndex((child) =>
        $(child)
          .find(sel(CLASS.count))
          .toArray()
          .some((marker) => POINT_ID.test($(marker).attr("id") ?? "")),
      )
    : -1;

  const walk = (printedNumbers: PrintedNumbering): Block[] => {
    const builder: BlockBuilder = {
      blocks: [],
      sequence: 0,
      counter: 0,
      zone: "header",
      inTitleRun: true,
      layout,
      pointsAreNumbering,
      printedNumbers,
      pendingPage: undefined,
    };
    for (const [index, child] of children.entries()) {
      visitChild({ $, builder, $el: $(child), index, lastPointIndex });
    }
    return builder.blocks;
  };

  if (layout === "classed") {
    return walk({ type: "settled", numbers: new Map() });
  }
  const candidates: PrintedNumberCandidate[] = [];
  walk({ type: "survey", candidates });
  return walk({
    type: "settled",
    numbers: settlePrintedNumbers(candidates),
  });
};

const tagNameOf = (node: AnyNode | undefined): string | undefined =>
  node !== undefined && isTag(node) ? node.tagName : undefined;

const classListOf = (el: cheerio.Cheerio<AnyNode>): string[] =>
  (el.attr("class") ?? "")
    .split(/\s+/u)
    .filter(Boolean)
    .map((name) =>
      name.startsWith(CLASS_PREFIX) ? name.slice(CLASS_PREFIX.length) : name,
    );

type VisitChildOptions = {
  $: cheerio.CheerioAPI;
  builder: BlockBuilder;
  $el: cheerio.Cheerio<AnyNode>;
  index: number;
  lastPointIndex: number;
};

const visitChild = ({
  $,
  builder,
  $el,
  index,
  lastPointIndex,
}: VisitChildOptions): void => {
  const node = $el.get(0);
  const tag = tagNameOf(node);
  const classes = classListOf($el);

  // `<hr class="coj-note">` opens the footnote list.
  if (tag === "hr") {
    builder.zone = "footnotes";
    return;
  }

  // The oldest layout names its sections only by the publisher's anchor
  // codes, which are the same in every language. The anchor's contents,
  // if the HTML parser put the section inside it, follow it in the walk.
  const sectionZone = node === undefined ? undefined : sectionAnchorZone(node);
  if (sectionZone !== undefined) {
    builder.zone = sectionZone;
    return;
  }

  if (tag === "table") {
    // A document with no numbered paragraphs has no operative part to
    // find; without this guard `index > -1` would mark its very first
    // table as the ruling.
    const opensOperativePart =
      builder.zone !== "footnotes" &&
      builder.zone !== "operative" &&
      lastPointIndex >= 0 &&
      index > lastPointIndex;
    if (opensOperativePart) {
      builder.zone = "operative";
    }
    const before = builder.blocks.length;
    visitTable($, builder, $el);
    if (opensOperativePart && opensWithUnmarkedRow($, $el)) {
      promoteToHeading(builder, before);
    }
    builder.inTitleRun = false;
    return;
  }

  if (node !== undefined && isText(node)) {
    const inlines: Inline[] = [];
    appendTextInline(inlines, node.data);
    const normalizedInlines = collapseWhitespace(inlines);
    const plainText = inlinesToPlainText(normalizedInlines).trim();
    if (!plainText) {
      return;
    }
    builder.inTitleRun = false;
    pushParagraph(builder, {
      ...roleOf(builder.zone),
      inlines: normalizedInlines,
      plainText,
    });
    return;
  }

  if (builder.layout === "legacy" && isContentsLine($, $el)) {
    return;
  }

  // Every other element falls through to the paragraph path rather
  // than being skipped. Losing text is the one failure this parser
  // must not have; rendering it with the wrong shape is recoverable.
  const inlines = walkEcjInlines($, $el);
  const plainText = inlinesToPlainText(inlines).trim();
  if (!plainText) {
    return;
  }

  // The oldest layout drops the class vocabulary entirely and marks
  // its sections with semantic heading tags. It never emits `h1`, so
  // its `h2` is the document's top level.
  const tagLevel = HEADING_TAGS[tag ?? ""];
  if (tagLevel !== undefined) {
    pushHeading(builder, {
      level: tagLevel,
      role: "section-heading",
      inlines,
      plainText,
    });
    builder.inTitleRun = false;
    return;
  }

  if (classes.includes(CLASS.title)) {
    pushHeading(builder, {
      level: 1,
      role: builder.inTitleRun ? "decision-title" : "section-heading",
      inlines,
      plainText,
    });
    return;
  }

  builder.inTitleRun = false;

  const grseqDepth = classDepth(classes, GRSEQ_CLASS);
  if (grseqDepth !== undefined) {
    pushHeading(builder, {
      level: toHeadingLevel(grseqDepth),
      role: "section-heading",
      inlines,
      plainText,
    });
    return;
  }

  const numberedLevel = sectionHeadingLevel($el, classes);
  if (numberedLevel !== undefined) {
    pushHeading(builder, {
      level: numberedLevel,
      role: "section-heading",
      inlines,
      plainText,
    });
    return;
  }

  if (builder.layout === "legacy" && tag === "p") {
    visitLegacyParagraph(builder, inlines, index);
    return;
  }

  pushParagraph(builder, {
    ...roleOf(builder.zone),
    inlines,
    plainText,
  });
};

// ── The oldest layout ──────────────────────────────────────

/**
 * The zone each section of the oldest layout opens, by the anchor code
 * in front of its heading: `I1`, `I2`… the parties and the subject, `MO`
 * the grounds, `CO` the costs, `VS` the recitals that close the oldest
 * judgments' grounds, `DI` the operative part. A code outside the set
 * leaves the zone as it was, so an unknown section cannot reclassify the
 * one before it.
 */
const sectionAnchorZone = (node: AnyNode): Zone | undefined => {
  const code =
    isTag(node) && node.tagName === "a" ? node.attribs["name"] : undefined;
  if (code === undefined) {
    return undefined;
  }
  if (/^I\d+$/u.test(code)) {
    return "header";
  }
  switch (code) {
    case "MO":
    case "CO":
    case "VS":
      return "body";
    case "DI":
      return "operative";
    default:
      return undefined;
  }
};

/**
 * The contents line the oldest layout opens with: links to its own
 * section anchors, separated by breaks. It is the publisher's navigation,
 * not the Court's text, and every entry repeats a section heading below.
 */
const isContentsLine = (
  $: cheerio.CheerioAPI,
  $el: cheerio.Cheerio<AnyNode>,
): boolean => {
  const nodes = $el.contents().toArray();
  const links = nodes.filter(
    (node) =>
      isTag(node) &&
      node.tagName === "a" &&
      ($(node).attr("href") ?? "").startsWith("#"),
  );
  return (
    links.length > 0 &&
    nodes.every(
      (node) =>
        links.includes(node) ||
        (isTag(node) && node.tagName === "br") ||
        (isText(node) && node.data.trim() === ""),
    )
  );
};

/**
 * A page of the printed Reports, which the oldest judgments carry as a
 * paragraph of its own (`P . 255`, `S . 222`): an abbreviation of up to
 * four letters, a full stop, a page number, nothing else.
 */
const REPORT_PAGE_MARKER = /^\p{L}{1,4}\s*\.\s*(?<page>\d{1,4})$/u;

/**
 * The paragraph number the oldest layout prints at the start of the
 * text: `37 It follows`, `1. Dne`, `20. 2003. június 26-án`, or, as the
 * 1970s typesetting has it, glued to the first word (`1BY ORDER OF`). The
 * text after it must open with a word, a figure, a quotation mark or a
 * bracket: `1 . MUST` is an item of a question quoted inside a paragraph,
 * never the Court's numbering.
 */
const PRINTED_PARAGRAPH_NUMBER =
  /^(?<number>\d{1,4})(?:(?<dot>\.)?\s+(?=[\p{L}\p{N}\p{Pi}\p{Ps}"'])|(?=\p{Lu}))/u;

/**
 * A paragraph that opens with a day of the month rather than a number:
 * the text after the figure is a month and a year (`1 May 2000`, `3 mai
 * 1999`, `12. März 1987`). Read as the text after the figure, so it holds
 * in every language that writes the day first.
 */
const MONTH_AND_YEAR = /^\p{L}{3,}\.?\s+\d{4}(?!\d)/u;

/** Highest day of a month; a larger figure is never a date. */
const DAYS_IN_MONTH_MAX = 31;

/**
 * Settle which printed numbers are the Court's paragraph numbering.
 *
 * The numbering runs 1, 2, 3… and every number is taken from the
 * candidates that continue it, so the choice can look ahead:
 *
 * - a candidate whose run continues further is preferred, so a stray
 *   number that the rest of the sequence does not follow is passed over;
 * - among those, one that does not open a date (`1 May 2000`);
 * - then one written the way the Court writes its numbers in this
 *   document (`2 Text` or `2. Text`), read off the numbers that only one
 *   paragraph carries: a quoted list (`2. Second alternative.`) is
 *   numbered the other way.
 *
 * Where that still leaves more than one, no paragraph takes the number:
 * a quoted item and the Court's paragraph look alike, and naming the
 * wrong one would cite text the Court never numbered. The run goes on
 * from the earliest of them.
 */
const settlePrintedNumbers = (
  candidates: readonly PrintedNumberCandidate[],
): ReadonlyMap<number, number> => {
  // How far the numbering runs from each candidate, read backwards: one
  // more than the longest run of the next number among those after it.
  const runFrom = new Map<number, number>();
  const reached: ReachedCandidate[] = [];
  for (const candidate of candidates.toReversed()) {
    const reach = 1 + (runFrom.get(candidate.number + 1) ?? 0);
    reached.push({ candidate, reach });
    runFrom.set(
      candidate.number,
      Math.max(runFrom.get(candidate.number) ?? 0, reach),
    );
  }
  const byNumber = Map.groupBy(
    reached.toReversed(),
    ({ candidate }) => candidate.number,
  );

  const courtMarker = courtMarkerOf(byNumber.values());

  const numbers = new Map<number, number>();
  let after = -1;
  for (let expected = 1; ; expected += 1) {
    const entries = byNumber.get(expected);
    const open = entries === undefined ? [] : candidatesAfter(entries, after);
    if (open.length === 0) {
      return numbers;
    }
    const pool = preferredCandidates({ courtMarker, open });
    const [chosen, ...alike] = pool;
    if (chosen !== undefined && alike.length === 0) {
      numbers.set(chosen.index, expected);
      after = chosen.index;
    } else {
      after = Math.min(...pool.map((candidate) => candidate.index));
    }
  }
};

type ReachedCandidate = { candidate: PrintedNumberCandidate; reach: number };

const candidatesAfter = (
  entries: readonly ReachedCandidate[],
  after: number,
): ReachedCandidate[] =>
  entries.filter(({ candidate }) => candidate.index > after);

/**
 * How the Court writes its numbers in this document: the marker most of
 * the numbers only one paragraph carries are written with, if one is.
 */
const courtMarkerOf = (
  groups: Iterable<readonly ReachedCandidate[]>,
): PrintedNumberCandidate["marker"] | undefined => {
  const lone = [...groups].flatMap(([only, ...others]) =>
    only !== undefined && others.length === 0 && !only.candidate.dated
      ? [only.candidate.marker]
      : [],
  );
  const dotted = lone.filter((marker) => marker === "dotted").length;
  const bare = lone.length - dotted;
  if (dotted === bare) {
    return undefined;
  }
  return dotted > bare ? "dotted" : "bare";
};

const preferring = <T>(pool: T[], test: (item: T) => boolean): T[] => {
  const preferred = pool.filter(test);
  return preferred.length > 0 ? preferred : pool;
};

/** The candidates for one number left once every preference is applied. */
const preferredCandidates = ({
  courtMarker,
  open,
}: {
  courtMarker: PrintedNumberCandidate["marker"] | undefined;
  open: readonly ReachedCandidate[];
}): PrintedNumberCandidate[] => {
  const longest = Math.max(...open.map((entry) => entry.reach));
  return preferring(
    preferring(
      open
        .filter((entry) => entry.reach === longest)
        .map(({ candidate }) => candidate),
      (candidate) => !candidate.dated,
    ),
    (candidate) => candidate.marker === courtMarker,
  );
};

/**
 * Longest sub-heading of the oldest layout. Its headings are a line of a
 * few words; a line that long without closing punctuation is a quotation
 * broken across paragraphs.
 */
const LEGACY_HEADING_MAX_LENGTH = 160;

/**
 * How a sentence, a clause or a quoted list item ends. The Court sets its
 * sub-headings as bare phrases, so a line ending in none of these is one.
 */
const SENTENCE_END = /[.,;:?!…"'”“»«’‘)\]]$/u;

/** A sub-heading opens with a word or a bracketed marker, never a quote or a dash. */
const HEADING_START = /^(?:\(\p{L}{1,3}\)\s*)?\p{L}/u;

/**
 * Depth of a sub-heading below the level-1 sections: a bracketed or
 * lower-case marker (`(a)`, `b)`) sits one level deeper than an unmarked
 * or capital-marked heading.
 */
const legacyHeadingLevel = (text: string): HeadingLevel =>
  /^(?:\(\p{L}{1,3}\)|\p{Ll}{1,3}\))\s/u.test(text) ? 3 : 2;

const isLegacyHeading = (text: string): boolean =>
  text.length <= LEGACY_HEADING_MAX_LENGTH &&
  HEADING_START.test(text) &&
  !SENTENCE_END.test(text);

/**
 * One bare paragraph of the oldest layout.
 *
 * Its structure is all in the text, so it is read off the text: a report
 * page marker becomes a page anchor on the next block, a printed number
 * that continues the Court's numbering becomes the paragraph's number,
 * and a bare phrase between the numbered paragraphs becomes a heading.
 * Only the grounds and the costs are numbered or sub-headed, so the
 * parties and the operative part keep their lines as they are. A number
 * is taken only where the whole sequence settles it as the Court's
 * (`settlePrintedNumbers`), so a date, an amount or a quoted list item
 * that happens to open a paragraph is never read as one.
 */
const visitLegacyParagraph = (
  builder: BlockBuilder,
  walked: readonly Inline[],
  index: number,
): void => {
  const line = normalizeInlineLine(walked);
  const page = REPORT_PAGE_MARKER.exec(line.plainText)?.groups?.["page"];
  if (page !== undefined) {
    builder.pendingPage = page;
    return;
  }

  if (builder.zone !== "body") {
    pushParagraph(builder, {
      ...roleOf(builder.zone),
      inlines: line.inlines,
      plainText: line.plainText,
    });
    return;
  }

  const { match, line: body } = stripInlineLinePrefix(
    line,
    PRINTED_PARAGRAPH_NUMBER,
  );
  const printed = parseIntegerToken(match?.groups?.["number"], {
    sign: "unsigned",
  });
  const { printedNumbers } = builder;
  if (
    Result.isOk(printed) &&
    body.plainText !== "" &&
    printedNumbers.type === "survey"
  ) {
    printedNumbers.candidates.push({
      index,
      number: printed.value,
      marker: match?.groups?.["dot"] === undefined ? "bare" : "dotted",
      dated:
        printed.value <= DAYS_IN_MONTH_MAX &&
        MONTH_AND_YEAR.test(body.plainText),
    });
  }
  const number =
    printedNumbers.type === "settled"
      ? printedNumbers.numbers.get(index)
      : undefined;
  if (number !== undefined) {
    pushParagraph(builder, {
      number,
      anchorId: `point${number}`,
      inlines: body.inlines,
      plainText: body.plainText,
    });
    return;
  }

  if (isLegacyHeading(line.plainText)) {
    pushHeading(builder, {
      level: legacyHeadingLevel(line.plainText),
      role: "section-heading",
      inlines: line.inlines,
      plainText: line.plainText,
    });
    return;
  }

  pushParagraph(builder, { inlines: line.inlines, plainText: line.plainText });
};

// ── The operative part ─────────────────────────────────────

/**
 * Whether a table's first row has an empty marker cell around a single
 * passage: the shape of the sentence introducing the ruling ("On those
 * grounds, the Court hereby rules:"), where a numbered or bulleted row
 * carries its marker.
 */
const opensWithUnmarkedRow = (
  $: cheerio.CheerioAPI,
  $table: cheerio.Cheerio<AnyNode>,
): boolean => {
  const [marker, content] = ownTableRows($table)
    .first()
    .children("td, th")
    .toArray();
  return (
    marker !== undefined &&
    content !== undefined &&
    textOf($(marker)) === "" &&
    $(content).find("table").length === 0
  );
};

/**
 * Turn the sentence introducing the operative part into its heading.
 *
 * The operative part has no heading of its own in this markup, so every
 * outline nested the ruling under whichever heading the reasoning ended
 * on ("Costs"). The sentence is the Court's own and is there in every
 * language, so it is the heading, rather than a label this parser would
 * have to supply in 24 languages.
 */
const promoteToHeading = (builder: BlockBuilder, index: number): void => {
  const block = builder.blocks[index];
  if (block?.type !== "paragraph" || block.number !== undefined) {
    return;
  }
  builder.blocks[index] = {
    id: block.id,
    anchorId: block.anchorId,
    type: "heading",
    level: 1,
    role: "section-heading",
    inlines: block.inlines,
    plainText: block.plainText,
  };
};

/**
 * Length in letters and digits. Punctuation is excluded so the
 * brackets a court leaves around a footnote reference cannot tip a
 * heading over the "fully emphasized" line.
 */
const dense = (text: string): number =>
  text.replace(/[^\p{L}\p{N}]/gu, "").length;

/**
 * A copy of the paragraph without its footnote references. They sit
 * outside the emphasis spans, so a heading that carries one would
 * otherwise read as only partly emphasized.
 */
const withoutNotes = (
  $el: cheerio.Cheerio<AnyNode>,
): cheerio.Cheerio<AnyNode> => {
  const clone = $el.clone();
  clone.find(sel(CLASS.note)).remove();
  return clone;
};

/**
 * Outline depth of a section heading the source does not classify.
 *
 * Opinions carry no heading class at all, and judgments express their
 * deepest level the same way: a `coj-normal` paragraph carrying a
 * section marker followed by an emphasized title (bold at the top
 * levels, italic at the deepest ones). Both signals are required.
 * Party names in the header are emphasized too, but hold no marker;
 * body prose is not emphasized.
 *
 * Reading the marker from its span rather than from the text keeps
 * this working across translations that punctuate differently: Finnish
 * writes `I Johdanto` where English writes `I. Introduction`.
 */
const sectionHeadingLevel = (
  $el: cheerio.Cheerio<AnyNode>,
  classes: readonly string[],
): HeadingLevel | undefined => {
  if (!classes.includes(CLASS.normal)) {
    return undefined;
  }

  const $body = withoutNotes($el);
  const text = textOf($body);
  const total = dense(text);
  const $first = $body.find(`${sel(CLASS.bold)}, ${sel(CLASS.italic)}`).first();
  if (total === 0 || $first.length === 0) {
    return undefined;
  }

  // The marker is whatever precedes the emphasized title. Where the
  // Court sets the marker itself (`I.` in its own bold span) that is
  // the first emphasis span; where it does not (`I – ` before a bold
  // title, or a bare dash before an italic one) it is the plain text
  // in front of that span.
  const title = textOf($first);
  const cut = text.indexOf(title);
  const lead = cut > 0 ? text.slice(0, cut).trim() : "";
  const marker = lead === "" ? title : lead;

  const titleLength = total - dense(marker);
  if (titleLength <= 0) {
    return undefined;
  }

  // Everything after the marker must be emphasized. That is what
  // separates a heading from body prose, and from a party name, which
  // is emphasized but carries no marker.
  const emphasized = Math.max(
    dense(visibleHtmlText($body.find(sel(CLASS.bold)))),
    dense(visibleHtmlText($body.find(sel(CLASS.italic)))),
  );
  if (emphasized < titleLength) {
    return undefined;
  }

  return markerLevel(marker);
};

/**
 * Depth of a section marker. Only the Roman numerals stay Latin across
 * translations; the alphabetic markers are localized, so Greek runs
 * `Α. Β. Γ. Δ. Ε. ΣΤ.` (its sixth marker is two letters). Matching
 * Romans on `I`, `V` and `X` alone rather than on the full Roman
 * alphabet keeps `C.` and `D.` on level 2 where they belong: judicial
 * outlines never run to a hundred sections, so those characters are
 * always letters here. Formex draws the same tree one level deeper
 * than the AST's three levels, so its levels 3 and below land on 3.
 */
const markerLevel = (marker: string): HeadingLevel | undefined => {
  const token = marker
    .replace(/^[(\s]+/u, "")
    .replace(/(?<![\s.)\u2013\u2014-])[\s.)\u2013\u2014-]+$/u, "");

  // A bare dash is the Court's deepest marker: it carries no ordinal.
  if (token === "") {
    return /[\u2013\u2014-]/u.test(marker) ? 3 : undefined;
  }

  // Below the letter level the Court switches to brackets and to lower
  // case (`a)`, `(1)`), which is how `A.` and `a)` stay distinguishable
  // in scripts where they are otherwise the same character class.
  const isDeep = /[()]/u.test(marker);

  if (!isDeep && /^[IVX]+$/u.test(token)) {
    return 1;
  }
  if (!isDeep && /^\p{Lu}{1,3}$/u.test(token)) {
    return 2;
  }
  return /^(?:\p{L}{1,3}|\d{1,3})$/u.test(token) ? 3 : undefined;
};

// ── Two-column rows ────────────────────────────────────────

/**
 * Cellar expresses every indented construct — numbered paragraphs,
 * quoted legislation, bullet lists, operative-part items — as a
 * single-row table whose first cell holds the marker and whose second
 * cell holds the content. Rows nest, so quotes inside a numbered
 * paragraph recurse through here.
 */
const visitTable = (
  $: cheerio.CheerioAPI,
  builder: BlockBuilder,
  $table: cheerio.Cheerio<AnyNode>,
): void => {
  $table.children("caption").each((_, caption) => {
    const inlines = walkEcjInlines($, $(caption));
    const plainText = inlinesToPlainText(inlines).trim();
    if (plainText) {
      pushParagraph(builder, { ...roleOf(builder.zone), inlines, plainText });
    }
  });
  // A spec-compliant tree builder gives every row an explicit section
  // parent, but that parent is `<tbody>` only for rows the source left
  // unsectioned: rows the source put in `<thead>` or `<tfoot>` stay
  // there, as siblings of `<tbody>` rather than inside it. Reading
  // `<tbody>` alone therefore drops a sectioned row whole — the column
  // labels of a quoted tariff table, or the note under it — which is the
  // one failure rule 10 does not allow, and which the cell selector
  // below cannot catch because the row never reaches it.
  ownTableRows($table).each((_, tr) => {
    // `th` counts as a cell. A decision quoting a tariff or rate
    // table carries that table's column labels in a header row, and
    // a row selected as `td` alone yields no cells at all — so the
    // row would be dropped whole rather than shaped wrong.
    const cells = $(tr).children("td, th").toArray();
    const [markerCell, contentCell, ...extraCells] = cells;
    if (!markerCell) {
      return;
    }
    if (!contentCell) {
      visitCell($, builder, $(markerCell), undefined);
      return;
    }

    const $marker = $(markerCell).find(sel(CLASS.count)).first();
    const pointNumber = builder.pointsAreNumbering
      ? POINT_ID.exec($marker.attr("id") ?? "")?.groups?.["number"]
      : undefined;

    if (pointNumber === undefined) {
      // Unanchored markers ("–", "(22)", "1.") belong to the text: they
      // number a quoted recital or an operative-part item.
      visitCell($, builder, $(contentCell), {
        marker: textOf($(markerCell)),
      });
    } else {
      builder.zone = builder.zone === "header" ? "body" : builder.zone;
      visitCell($, builder, $(contentCell), {
        number: Number.parseInt(pointNumber, 10),
      });
    }

    // The marker/content pair is the converter's shape for a numbered
    // paragraph, not a bound on the row: a quoted table has a column
    // per tariff heading, description and rate, and the pair alone
    // would silently keep the first two of them. Anything past the
    // pair still contributes its text, in document order.
    for (const cell of extraCells) {
      visitCell($, builder, $(cell), undefined);
    }
  });
};

type CellContext =
  | { number: number; marker?: undefined }
  | { marker: string; number?: undefined }
  | undefined;

/**
 * Cellar's inline vocabulary inside a cell. Anything outside it opens a
 * block of its own, so each `<p class="coj-normal">` of a quoted passage
 * stays a separate paragraph and an unrecognised element keeps the
 * paragraph it used to get. `<br>` is inline too, but it is empty and
 * is handled before this set: see `visitCell`.
 */
const INLINE_TAGS = new Set([
  "a",
  "b",
  "em",
  "i",
  "img",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "u",
]);

/**
 * Drop the breaks and blank text at a run's edges. A break separates two
 * lines, so one with nothing on the far side of it opens or closes the
 * paragraph on an empty line — the whitespace `collapseWhitespace` trims,
 * written as a tag. The blank text goes with it: `A <br> ` puts an
 * indentation gap on each side of the break, and stopping the walk at
 * that gap would leave the break it surrounds. Nothing readable is lost;
 * neither node carries a word.
 */
const trimEdgeTrivia = (inlines: Inline[]): Inline[] => {
  const isTrivia = (node: Inline | undefined): boolean =>
    node?.type === "line-break" ||
    (node?.type === "text" && node.text.trim() === "");

  while (isTrivia(inlines[0])) {
    inlines.shift();
  }
  while (isTrivia(inlines.at(-1))) {
    inlines.pop();
  }
  return inlines;
};

const visitCell = (
  $: cheerio.CheerioAPI,
  builder: BlockBuilder,
  $cell: cheerio.Cheerio<AnyNode>,
  context: CellContext,
): void => {
  const before = builder.blocks.length;
  const signature = isSignature($, $cell);

  // A cell mixes its own text with elements: Cellar writes a quoted
  // entry as loose text around the spans that emphasize part of it.
  // Walking `children()` alone reaches the elements and never the text
  // between them, so that text was dropped whenever any element child
  // produced a block — the one failure rule 10 does not allow. Collect
  // the loose run instead and close it whenever a block child starts.

  // The walker marks everything inside an `anon-block` element, but its
  // walk starts at the node it is given: a cell (or a row) carrying the
  // class itself is above every walk this function starts, so the state
  // has to be read from the cell's ancestry and seeded into each of
  // them. Loose text is the cell's content like the elements beside it
  // and carries the same flag.
  const anonymized = $cell.closest(`.${ANONYMIZED_CLASS}`).length > 0;
  const inlineOptions = { ...ECJ_INLINE_OPTIONS, anonymized };

  let run: Inline[] = [];
  const flushRun = (): void => {
    const inlines = collapseWhitespace(trimEdgeTrivia(run));
    run = [];
    const plainText = inlinesToPlainText(inlines).trim();
    if (!plainText) {
      return;
    }
    pushParagraph(builder, {
      ...roleOf(builder.zone, signature),
      inlines,
      plainText,
    });
  };

  $cell.contents().each((_, child) => {
    if (isText(child)) {
      appendTextInline(run, child.data, anonymized);
      return;
    }

    if (!isTag(child)) {
      return;
    }

    const $child = $(child);
    const tag = child.tagName.toLowerCase();

    if (tag === "table") {
      flushRun();
      visitTable($, builder, $child);
      return;
    }

    if (tag === "div") {
      flushRun();
      visitCell($, builder, $child, undefined);
      return;
    }

    // `walkInlines` reads a node's contents, and an empty element
    // carries its meaning in the tag instead, so handing it a `<br>`
    // yields nothing and welds the lines around the break together.
    // Emit the break the walker emits for a `<br>` nested in a span,
    // which keeps `A<br>B` two lines wherever the break sits.
    if (tag === "br") {
      run.push({ type: "line-break" });
      return;
    }

    // Untrimmed: the run's edges are trimmed once, in `flushRun`, so a
    // span's own leading space still separates it from the text before.
    if (INLINE_TAGS.has(tag)) {
      run.push(...walkInlines($, $child, inlineOptions));
      return;
    }

    flushRun();

    // As in `visitChild`: anything else still contributes its text.
    const inlines = walkEcjInlines($, $child, inlineOptions);
    const plainText = inlinesToPlainText(inlines).trim();
    if (!plainText) {
      return;
    }

    pushParagraph(builder, {
      ...roleOf(builder.zone, signature),
      inlines,
      plainText,
    });
  });

  flushRun();

  const first = builder.blocks[before];
  if (!first || first.type !== "paragraph") {
    return;
  }

  if (context?.number !== undefined) {
    first.number = context.number;
    first.anchorId = `point${context.number}`;
    for (const [offset, block] of builder.blocks.slice(before + 1).entries()) {
      block.anchorId = `point${context.number}-${offset + 2}`;
    }
    return;
  }

  if (context?.marker) {
    prefixParagraph(first, `${context.marker} `);
  }
};

/** Re-attach an unanchored row marker to the text it numbers. */
const prefixParagraph = (block: ParagraphBlock, prefix: string): void => {
  block.inlines = [{ type: "text", text: prefix }, ...block.inlines];
  block.plainText = `${prefix}${block.plainText}`;
};

const isSignature = (
  $: cheerio.CheerioAPI,
  $cell: cheerio.Cheerio<AnyNode>,
): boolean =>
  $cell
    .find("*")
    .addBack()
    .toArray()
    .some((el) =>
      classListOf($(el)).some((name) =>
        name.startsWith(SIGNATURE_CLASS_PREFIX),
      ),
    );
