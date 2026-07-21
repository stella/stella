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

import * as cheerio from "cheerio";
import { type AnyNode, isTag } from "domhandler";

import type {
  Block,
  DocumentAst,
  HeadingBlock,
  Inline,
  ParagraphBlock,
  ParagraphRole,
} from "@/api/handlers/case-law/document-ast";
import { validateAndLog } from "@/api/handlers/case-law/ingestion/parsers/validate-ast";
import { sanitizeUrl } from "@/api/lib/sanitize-url";

import { inlinesToPlainText, walkInlines } from "./shared-inlines";

// ── Public API ─────────────────────────────────────────────

export type ParseEcjDecisionInput = {
  caseNumber: string;
  ecli: string | undefined;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  /** Human-facing EUR-Lex URL for the decision. */
  sourceUrl: string | undefined;
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
   * Codes of the issues `validateAndLog` raised, empty on a clean
   * parse. Returned rather than only logged so callers can assert on
   * content retention without re-walking the source document.
   */
  validationIssues: string[];
};

export const parseEcjDecisionHtml = (
  input: ParseEcjDecisionInput,
): ParseEcjDecisionOutput => {
  const $ = cheerio.load(input.html);
  const blocks = buildBlocks($);
  const keywords = extractKeywords($);

  const validation = validateAndLog(
    "eu-ecj",
    input.caseNumber,
    input.html,
    blocks,
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
const walkEcjInlines = (
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<AnyNode>,
): Inline[] =>
  collapseWhitespace(
    walkInlines($, el, {
      sanitizeHref: sanitizeUrl,
      emphasisClasses: {
        bold: [CLASS.bold, `${CLASS_PREFIX}${CLASS.bold}`],
        italic: [CLASS.italic, `${CLASS_PREFIX}${CLASS.italic}`],
      },
    }),
  );

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
    if (node.type === "line-break") {
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
  if (node === undefined || node.type === "line-break") {
    return;
  }
  if (node.type === "text") {
    inlines[index] = {
      ...node,
      text: edge === "start" ? node.text.trimStart() : node.text.trimEnd(),
    };
    return;
  }
  trimEdge(node.children, edge);
};

const textOf = (el: cheerio.Cheerio<AnyNode>): string =>
  el.text().replace(/\s+/gu, " ").trim();

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
const extractKeywords = ($: cheerio.CheerioAPI): string[] => {
  // Read the raw text rather than `textOf`: the separator is defined by
  // its exact spacing, which whitespace collapsing would destroy.
  const raw = $(sel(CLASS.index)).first().text().trim();
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

// ── Block building ─────────────────────────────────────────

type Zone = "header" | "body" | "operative" | "footnotes";

type BlockBuilder = {
  blocks: Block[];
  /** Sequence number for blocks without a publisher anchor. */
  sequence: number;
  /** Monotonic id counter, independent of anchor naming. */
  counter: number;
  zone: Zone;
  /** True while no block other than a title line has been emitted. */
  inTitleRun: boolean;
};

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

const pushHeading = (
  builder: BlockBuilder,
  heading: Omit<HeadingBlock, "id" | "anchorId" | "type">,
): void => {
  builder.blocks.push({
    id: nextId(builder),
    anchorId: nextAnchor(builder, "h"),
    type: "heading",
    ...heading,
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
  });
};

const buildBlocks = ($: cheerio.CheerioAPI): Block[] => {
  const children = $("body").children().toArray();
  const builder: BlockBuilder = {
    blocks: [],
    sequence: 0,
    counter: 0,
    zone: "header",
    inTitleRun: true,
  };

  // The operative part is everything between the last numbered
  // paragraph and the signature/footnote tail. Locating its start needs
  // a look-ahead, so resolve it before the forward walk.
  const lastPointIndex = children.findLastIndex((child) =>
    $(child)
      .find(sel(CLASS.count))
      .toArray()
      .some((marker) => POINT_ID.test($(marker).attr("id") ?? "")),
  );

  for (const [index, child] of children.entries()) {
    visitChild($, builder, $(child), index, lastPointIndex);
  }

  return builder.blocks;
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

const visitChild = (
  $: cheerio.CheerioAPI,
  builder: BlockBuilder,
  $el: cheerio.Cheerio<AnyNode>,
  index: number,
  lastPointIndex: number,
): void => {
  const tag = tagNameOf($el.get(0));
  const classes = classListOf($el);

  // `<hr class="coj-note">` opens the footnote list.
  if (tag === "hr") {
    builder.zone = "footnotes";
    return;
  }

  if (tag === "table") {
    if (builder.zone !== "footnotes" && index > lastPointIndex) {
      builder.zone = "operative";
    }
    visitTable($, builder, $el);
    builder.inTitleRun = false;
    return;
  }

  // A container of block-level children is walked, not flattened.
  // The Publications Office's oldest XHTML wraps a whole decision in
  // `div.listNotice > div.texte`, which would otherwise collapse into
  // a single paragraph holding the entire judgment.
  if ($el.children("p, div, table").length > 0) {
    for (const child of $el.children().toArray()) {
      visitChild($, builder, $(child), index, lastPointIndex);
    }
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

  pushParagraph(builder, {
    ...roleOf(builder.zone),
    inlines,
    plainText,
  });
};

/**
 * Length in letters and digits. Punctuation is excluded so the
 * brackets a court leaves around a footnote reference cannot tip a
 * heading over the "fully emphasized" line.
 */
const dense = (text: string): number =>
  (text.match(/[\p{L}\p{N}]/gu) ?? []).length;

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
 * Deepest section marker in a judgment: an en dash, written as plain
 * text before the emphasized title rather than inside a span of its
 * own. Formex numbers this level 4, below the AST's three levels.
 */
const SECTION_DASH = /^[\u2013\u2014-]\s/u;

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
  if (total === 0) {
    return undefined;
  }

  // The marker is either a dash written as plain text, or the
  // paragraph's first emphasis span. Everything after it must be
  // emphasized: that is what separates a heading from body prose, and
  // from a party name, which is emphasized but holds no marker.
  const dash = SECTION_DASH.exec(text)?.[0];
  const marker =
    dash ??
    textOf($body.find(`${sel(CLASS.bold)}, ${sel(CLASS.italic)}`).first());
  const title = total - dense(marker);
  if (marker === "" || title <= 0) {
    return undefined;
  }

  const emphasized = Math.max(
    dense($body.find(sel(CLASS.bold)).text()),
    dense($body.find(sel(CLASS.italic)).text()),
  );
  if (emphasized < title) {
    return undefined;
  }

  // A dash is the Court's deepest marker; it carries no ordinal.
  return dash === undefined ? markerLevel(marker) : 3;
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
  const token = marker.replace(/^\(|[.)]$/gu, "");
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
  // `cheerio.load` runs a spec-compliant tree builder, so every row is
  // reachable through an explicit `<tbody>` even when the source omits it.
  $table
    .children("tbody")
    .children("tr")
    .each((_, tr) => {
      const cells = $(tr).children("td").toArray();
      const [markerCell, contentCell] = cells;
      if (!markerCell) {
        return;
      }
      if (!contentCell) {
        visitCell($, builder, $(markerCell), undefined);
        return;
      }

      const $marker = $(markerCell).find(sel(CLASS.count)).first();
      const pointNumber = POINT_ID.exec($marker.attr("id") ?? "")?.groups?.[
        "number"
      ];

      if (pointNumber !== undefined) {
        builder.zone = builder.zone === "header" ? "body" : builder.zone;
        visitCell($, builder, $(contentCell), {
          number: Number.parseInt(pointNumber, 10),
        });
        return;
      }

      // Unanchored markers ("–", "(22)", "1.") belong to the text: they
      // number a quoted recital or an operative-part item.
      visitCell($, builder, $(contentCell), {
        marker: textOf($(markerCell)),
      });
    });
};

type CellContext =
  | { number: number; marker?: undefined }
  | { marker: string; number?: undefined }
  | undefined;

const visitCell = (
  $: cheerio.CheerioAPI,
  builder: BlockBuilder,
  $cell: cheerio.Cheerio<AnyNode>,
  context: CellContext,
): void => {
  const before = builder.blocks.length;
  const signature = isSignature($, $cell);
  const cellText = textOf($cell);

  $cell.children().each((_, child) => {
    const $child = $(child);
    const tag = tagNameOf(child);

    if (tag === "table") {
      visitTable($, builder, $child);
      return;
    }

    if (tag === "div") {
      visitCell($, builder, $child, undefined);
      return;
    }

    // As in `visitChild`: anything else still contributes its text.
    const inlines = walkEcjInlines($, $child);
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

  // A cell holding bare text rather than paragraphs would otherwise
  // contribute nothing.
  if (builder.blocks.length === before && cellText !== "") {
    pushParagraph(builder, {
      ...roleOf(builder.zone, signature),
      inlines: [{ type: "text", text: cellText }],
      plainText: cellText,
    });
  }

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
