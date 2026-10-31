// parser-output-unchanged: The case DOM is shared for one assembly and cleanup happens on one owned clone; stored fields, HTML and AST output are unchanged.
// parser-output-unchanged: The retention check moved to the pipeline; dropping the parser's own retention self-check changes no stored field or AST.
/**
 * Polish Constitutional Tribunal (ipo.trybunal.gov.pl) page reader.
 *
 * The portal serves one page per case (`Sprawa`), and that page carries every
 * ruling issued in the case: a case record (`metryka`) shared by all of them,
 * then one tab per ruling holding its own record, its bench and its full text.
 * A ruling is therefore read out of its case page by the portal's document id,
 * and the case record is repeated onto each ruling built from it.
 *
 * Both records are label/value lists (`.prop > .name + .value`), with the
 * repeating ones (parties, reviewed provisions, constitutional standards, the
 * case's filings) rendered as titled panels. The labels are the source's field
 * names, and {@link listPlTkPageFields} reads them back for the inventory.
 */

import { panic } from "better-result";
import * as cheerio from "cheerio";
import { type AnyNode, type Element, isTag, isText } from "domhandler";

// parser-output-unchanged: imports the document AST from its package owner
import type {
  Block,
  DocumentAst,
  HeadingBlock,
  Inline,
  ParagraphBlock,
  ParagraphRole,
} from "@stll/legal-ast/document-ast";

import {
  EXCLUDED_HTML_SELECTOR,
  inlinesToPlainText,
  ownTableRows,
  visibleHtmlText,
  walkInlines,
} from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";
import { collapseHtmlWhitespace } from "@/api/lib/legal-search/document-builders/html-whitespace";
import {
  type MetadataUrlDefect,
  type SafeHref,
  sanitizeUrl,
  toMetadataUrl,
} from "@/api/lib/sanitize-url";

export const PL_TK_ORIGIN = "https://ipo.trybunal.gov.pl";

const PL_TK_SOURCE_SYSTEM = "ipo.trybunal.gov.pl";

// ── Text helpers ─────────────────────────────────────────

const collapse = (text: string): string => text.replace(/\s+/gu, " ").trim();

const POLISH_MONTHS = {
  stycznia: 1,
  lutego: 2,
  marca: 3,
  kwietnia: 4,
  maja: 5,
  czerwca: 6,
  lipca: 7,
  sierpnia: 8,
  września: 9,
  października: 10,
  listopada: 11,
  grudnia: 12,
} as const satisfies Record<string, number>;

const isPolishMonth = (value: string): value is keyof typeof POLISH_MONTHS =>
  Object.hasOwn(POLISH_MONTHS, value);

const POLISH_DATE = /(?<day>\d{1,2})\s+(?<month>\p{L}+)\s+(?<year>\d{4})/u;

/**
 * `25 czerwca 2026` as an ISO date, or `undefined` for anything else. The
 * portal writes the month in the genitive and sometimes pads the day with a
 * second space, which the pattern absorbs.
 */
export const parsePolishDate = (text: string): string | undefined => {
  const groups = POLISH_DATE.exec(text)?.groups;
  const month = groups?.["month"]?.toLocaleLowerCase("pl-PL");
  const day = groups?.["day"];
  const year = groups?.["year"];
  if (
    month === undefined ||
    day === undefined ||
    year === undefined ||
    !isPolishMonth(month)
  ) {
    return undefined;
  }
  const dayNumber = Number(day);
  if (dayNumber < 1 || dayNumber > 31) {
    return undefined;
  }
  return `${year}-${String(POLISH_MONTHS[month]).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
};

const absoluteUrl = (href: string | undefined): string | undefined => {
  if (href === undefined || href.length === 0) {
    return undefined;
  }
  const url = URL.parse(href, `${PL_TK_ORIGIN}/ipo/`);
  return url === null || !["http:", "https:"].includes(url.protocol)
    ? undefined
    : url.toString();
};

const metadataUrlOf = (href: string | undefined) => {
  if (href?.trim().length === 0) {
    return undefined;
  }
  const resolved = absoluteUrl(href);
  return resolved === undefined
    ? undefined
    : toMetadataUrl(resolved, "constructed");
};

// ── Page structure ───────────────────────────────────────

type PlTkLink = { text: string; url: SafeHref | MetadataUrlDefect };

/** One line of `Miejsce publikacji`: the citation and the links beside it. */
type PlTkPublication = { text: string; links: PlTkLink[] };

/** One legal act of a `Przedmiot sprawy` or `Wzorce` tree, with its units. */
type PlTkActProvisions = { act: string; provisions: string[] };

type PlTkPanelJudge = {
  name: string;
  /** The portal's own judge id (`Szukaj?sedzia=`), where it links one. */
  judgeId: string | undefined;
  /** `przewodniczący`, `sprawozdawca`; empty for an ordinary member. */
  functions: string[];
};

/** One dissenting opinion appended to the ruling's text. */
type PlTkDissent = {
  /** The printed heading line naming its authors, in the genitive. */
  authorsAsPrinted: string;
  /** Judges of the bench the heading names, as the bench table prints them. */
  judges: string[];
};

/** What the case record states once for every ruling in the case. */
export type PlTkCaseRecord = {
  caseNumber: string | undefined;
  filedDate: string | undefined;
  filedStkDate: string | undefined;
  originatesFrom: string[];
  transferredTo: string[];
  joinedCases: string[];
  signalledCase: string[];
  parties: string[];
  challengedProvisions: PlTkActProvisions[];
  constitutionalStandards: PlTkActProvisions[];
  caseDocuments: PlTkLink[];
};

/** What one ruling's tab states, and its text. */
export type PlTkRuling = {
  documentId: string;
  decisionForm: string | undefined;
  decisionDate: string | undefined;
  subject: string | undefined;
  publications: PlTkPublication[];
  /** The bold note the portal prints under the publication list, if any. */
  note: string | undefined;
  panel: PlTkPanelJudge[];
  /** The Word rendering the portal offers for download. */
  wordDocumentUrl: SafeHref | MetadataUrlDefect | undefined;
  /** Footnotes the text carries, publication annotations among them. */
  footnotes: string[];
  dissents: PlTkDissent[];
  /**
   * The deciding body as the ruling's own text names it, in the line that
   * introduces the bench (`Trybunał Konstytucyjny w składzie:`).
   */
  courtAsPrinted: string | undefined;
  /** The text container's markup, with the portal's widgets removed. */
  textHtml: string | undefined;
};

export type PlTkCasePage = {
  record: PlTkCaseRecord;
  /** Every ruling tab on the page, in the portal's order. */
  rulingIds: string[];
};

type Root = cheerio.CheerioAPI;

/** One case page's owned DOM and the indexes derived while parsing it once. */
export type ParsedPlTkPage = {
  $: Root;
  fields: string[];
  propsByContainer: Map<AnyNode, Map<string, cheerio.Cheerio<AnyNode>>>;
  cleanedTextByDocumentId: Map<string, cheerio.Cheerio<AnyNode>>;
};

/** Ids JSF writes with colons; an attribute selector needs no escaping. */
const byId = ($: Root, id: string): cheerio.Cheerio<AnyNode> =>
  $(`[id="${id}"]`);

const propName = (prop: cheerio.Cheerio<AnyNode>): string | undefined => {
  const name = collapse(visibleHtmlText(prop.children(".name").first()));
  return name.length === 0 ? undefined : name;
};

/**
 * The `.prop` rows directly under a record container, keyed by label. The
 * ruling tab repeats its record in a `Metryka orzeczenia` accordion; only the
 * first occurrence of a label is read, which is the tab's own.
 */
const propsOf = (
  page: ParsedPlTkPage,
  container: cheerio.Cheerio<AnyNode>,
): Map<string, cheerio.Cheerio<AnyNode>> => {
  const node = container.get(0);
  return node === undefined
    ? new Map<string, cheerio.Cheerio<AnyNode>>()
    : (page.propsByContainer.get(node) ??
        new Map<string, cheerio.Cheerio<AnyNode>>());
};

const valueText = (
  value: cheerio.Cheerio<AnyNode> | undefined,
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const text = collapse(visibleHtmlText(value));
  return text.length === 0 ? undefined : text;
};

const caseNumbersOf = (
  $: Root,
  value: cheerio.Cheerio<AnyNode> | undefined,
): string[] =>
  value === undefined
    ? []
    : value
        .find(".sygnatura")
        .toArray()
        .map((element) => collapse(visibleHtmlText($(element))))
        .filter((text) => text.length > 0);

/** The panel whose title reads `title`, scoped to `container`. */
const panelContent = (
  $: Root,
  container: cheerio.Cheerio<AnyNode>,
  title: string,
): cheerio.Cheerio<AnyNode> | undefined => {
  const panel = container
    .find(".ui-panel")
    .filter(
      (_, element) =>
        collapse(
          visibleHtmlText($(element).find(".ui-panel-title").first()),
        ) === title,
    )
    .first();
  return panel.length === 0 ? undefined : panel;
};

const listItemsOf = (
  $: Root,
  panel: cheerio.Cheerio<AnyNode> | undefined,
): string[] =>
  panel === undefined
    ? []
    : panel
        .find("li.ui-datalist-item")
        .toArray()
        .map((element) => collapse(visibleHtmlText($(element))))
        .filter((text) => text.length > 0);

const treeOf = (
  $: Root,
  panel: cheerio.Cheerio<AnyNode> | undefined,
): PlTkActProvisions[] => {
  if (panel === undefined) {
    return [];
  }
  return panel
    .find('li[data-nodetype="AktNormatywnySlownik"]')
    .toArray()
    .map((element) => {
      const node = $(element);
      const act = collapse(
        visibleHtmlText(
          node.children(".ui-treenode-content").find(".ui-treenode-label"),
        ),
      );
      const provisions = node
        .children(".ui-treenode-children")
        .children("li")
        .toArray()
        .map((child) =>
          collapse(
            visibleHtmlText(
              $(child)
                .children(".ui-treenode-content")
                .find(".ui-treenode-label"),
            ),
          ),
        )
        .filter((text) => text.length > 0);
      return { act, provisions };
    })
    .filter((entry) => entry.act.length > 0);
};

const METRYKA_ID = "sprawaForm:tabView:metryka";
const CASE_DOCUMENTS_ID = "sprawaForm:tabView:dokumentyWSprawie";
const RULING_TAB_PREFIX = "sprawaForm:tabView:dok_";

const RULING_TAB_ID = /^sprawaForm:tabView:dok_(?<id>\d+)$/u;

/** Parse and index one case page. The returned value belongs to that assembly. */
export const parsePlTkPage = (html: string): ParsedPlTkPage => {
  const $ = cheerio.load(html);
  const scope = $('[id="sprawaForm:tabView"]');
  const containers = [
    ...byId($, METRYKA_ID).toArray().filter(isTag),
    ...$(`[id^="${RULING_TAB_PREFIX}"]`)
      .toArray()
      .filter(isTag)
      .filter((element) => {
        const id = element.attribs["id"];
        return id !== undefined && RULING_TAB_ID.test(id);
      }),
  ];
  const propsByContainer = new Map<
    AnyNode,
    Map<string, cheerio.Cheerio<AnyNode>>
  >();
  for (const container of containers) {
    const props = new Map<string, cheerio.Cheerio<AnyNode>>();
    $(container)
      .find(".prop")
      .each((_, element) => {
        const prop = $(element);
        const name = propName(prop);
        if (name !== undefined && !props.has(name)) {
          props.set(name, prop.children(".value").first());
        }
      });
    propsByContainer.set(container, props);
  }
  const names = new Set<string>();
  scope.find(".prop").each((_, element) => {
    const name = propName($(element));
    if (name === undefined) {
      return;
    }
    names.add(name);
  });
  scope
    .find(".ui-panel-title, .ui-datatable-header, .ui-datalist-header")
    .each((_, element) => {
      const name = collapse(visibleHtmlText($(element)));
      if (name.length > 0) {
        names.add(name);
      }
    });
  return {
    $,
    fields: [...names],
    propsByContainer,
    cleanedTextByDocumentId: new Map<string, cheerio.Cheerio<AnyNode>>(),
  };
};

/** The case record, or `null` for a page that is not a case page. */
export const readPlTkCasePage = (page: ParsedPlTkPage): PlTkCasePage | null => {
  const { $ } = page;
  const metryka = byId($, METRYKA_ID);
  if (metryka.length === 0) {
    return null;
  }
  const props = propsOf(page, metryka);
  const documents = byId($, CASE_DOCUMENTS_ID);
  const rulingIds = $(`[id^="${RULING_TAB_PREFIX}"]`)
    .toArray()
    .flatMap((element) => {
      const id = isTag(element) ? element.attribs["id"] : undefined;
      const match = id === undefined ? null : RULING_TAB_ID.exec(id);
      const rulingId = match?.groups?.["id"];
      return rulingId === undefined ? [] : [rulingId];
    });

  return {
    record: {
      caseNumber: valueText(props.get("Sygnatura")),
      filedDate: parsePolishDate(
        valueText(props.get("Data wpływu do TK")) ?? "",
      ),
      filedStkDate: parsePolishDate(
        valueText(props.get("Data wpływu do STK")) ?? "",
      ),
      originatesFrom: caseNumbersOf($, props.get("Pochodzi z")),
      transferredTo: caseNumbersOf($, props.get("Przeniesiona do")),
      joinedCases: caseNumbersOf($, props.get("Sprawy dołączone")),
      signalledCase: caseNumbersOf($, props.get("Sygnalizacja w sprawie")),
      parties: listItemsOf($, panelContent($, metryka, "Podmiot w sprawie")),
      challengedProvisions: treeOf(
        $,
        panelContent($, metryka, "Przedmiot sprawy"),
      ),
      constitutionalStandards: treeOf($, panelContent($, metryka, "Wzorce")),
      caseDocuments: documents
        .find("li a")
        .toArray()
        .flatMap((element) => {
          const url = metadataUrlOf($(element).attr("href"));
          const text = collapse(visibleHtmlText($(element)));
          return url === undefined ? [] : [{ text, url }];
        }),
    },
    rulingIds,
  };
};

// ── Field names ──────────────────────────────────────────

/**
 * Every label the page states: record labels, panel titles and table
 * headers, across the case record and every ruling tab.
 */
export const listPlTkPageFields = (page: ParsedPlTkPage): string[] =>
  page.fields;

// ── One ruling ───────────────────────────────────────────

const publicationsOf = (
  $: Root,
  value: cheerio.Cheerio<AnyNode> | undefined,
): PlTkPublication[] => {
  if (value === undefined) {
    return [];
  }
  return value
    .children("table")
    .children("tbody")
    .children("tr")
    .toArray()
    .map((row) => {
      const cells = $(row);
      const links = cells
        .find("a")
        .toArray()
        .flatMap((anchor) => {
          const url = metadataUrlOf($(anchor).attr("href"));
          return url === undefined
            ? []
            : [{ text: collapse(visibleHtmlText($(anchor))), url }];
        });
      // The Dz.U./M.P. line prints its register links (ISAP, RCL) as cells
      // of their own; the citation is what the first cell says.
      const first = cells.children("td").first();
      const nested = ownTableRows(first.find("table").first())
        .children("td")
        .first();
      const text = collapse(
        visibleHtmlText(nested.length > 0 ? nested : first),
      );
      return { text, links };
    })
    .filter((entry) => entry.text.length > 0);
};

const JUDGE_ID = /[?&]sedzia=(?<id>\d+)/u;

const panelOf = (
  $: Root,
  tab: cheerio.Cheerio<AnyNode>,
  documentId: string,
): PlTkPanelJudge[] =>
  tab
    .find(`[id$="dataTable_${documentId}_data"]`)
    .first()
    .children("tr")
    .toArray()
    .flatMap((row) => {
      const cells = $(row).children("td");
      const name = collapse(visibleHtmlText(cells.eq(0)));
      if (name.length === 0) {
        return [];
      }
      const href = cells.eq(0).find("a").attr("href") ?? "";
      const functions = collapse(visibleHtmlText(cells.eq(1)))
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      return [
        {
          name,
          judgeId: JUDGE_ID.exec(href)?.groups?.["id"],
          functions,
        },
      ];
    });

/**
 * The stem a Polish surname keeps through declension, for finding a judge
 * named in the genitive (`Andrzeja Zielonackiego`) on a bench printed in the
 * nominative (`Andrzej Zielonacki`). Final vowels are what the cases change.
 */
const VOWELS = new Set(["a", "ą", "e", "ę", "i", "o", "ó", "u", "y"]);

const surnameStem = (name: string): string | undefined => {
  const surname = name.split(/\s+/u).at(-1) ?? "";
  let stem = surname.toLocaleLowerCase("pl-PL");
  while (stem.length > 0 && VOWELS.has(stem.at(-1) ?? "")) {
    stem = stem.slice(0, -1);
  }
  return stem.length >= 3 ? stem : undefined;
};

/** Bench judges whose surname the dissent heading names. */
const dissentJudges = (heading: string, panel: PlTkPanelJudge[]): string[] => {
  const words = heading.toLocaleLowerCase("pl-PL").split(/[\s,]+/u);
  return panel.flatMap((judge) => {
    const stem = surnameStem(judge.name);
    return stem !== undefined && words.some((word) => word.startsWith(stem))
      ? [judge.name]
      : [];
  });
};

/** `sędziego TK …`, `sędzi TK …`, `sędziów TK … i …`: a dissent's authors. */
const DISSENT_AUTHORS = /\bsędzi\p{L}*\s/iu;

/** Where a dissent names its authors: in its heading, or on its own line. */
type DissentAuthors =
  | { printedIn: "heading"; authorsAsPrinted: string }
  | {
      printedIn: "line";
      authorsAsPrinted: string;
      line: cheerio.Cheerio<AnyNode>;
    };

/**
 * The authors of one `wyrok_zdanieodrebne` block. The Tribunal prints them
 * either in the heading itself (`Zdanie odrębne sędziego TK …`) or as the
 * first numbered line under a bare `Zdanie odrębne` heading, followed by the
 * line naming the ruling (`do wyroku Trybunału Konstytucyjnego z …`), which
 * names no judge and is never read as one.
 */
const dissentAuthorsOf = (
  dissent: cheerio.Cheerio<AnyNode>,
): DissentAuthors | undefined => {
  const heading = collapse(
    visibleHtmlText(dissent.find(".wyrok_naglowekNumerowany").first()),
  );
  const inHeading = DISSENT_AUTHORS.exec(heading);
  if (inHeading !== null) {
    return {
      printedIn: "heading",
      authorsAsPrinted: heading.slice(inHeading.index),
    };
  }
  const line = dissent.find(".wyrok_akapitNumerowany").first();
  const text = collapse(visibleHtmlText(line));
  return DISSENT_AUTHORS.exec(text)?.index === 0
    ? { printedIn: "line", authorsAsPrinted: text, line }
    : undefined;
};

/** Each dissent's authors as printed, and the bench judges they name. */
const dissentsOf = (
  $: Root,
  text: cheerio.Cheerio<AnyNode>,
  panel: PlTkPanelJudge[],
): PlTkDissent[] =>
  text
    .find(".wyrok_zdanieodrebne")
    .toArray()
    .flatMap((element) => {
      const authors = dissentAuthorsOf($(element));
      return authors === undefined
        ? []
        : [
            {
              authorsAsPrinted: authors.authorsAsPrinted,
              judges: dissentJudges(authors.authorsAsPrinted, panel),
            },
          ];
    });

const footnotesOf = ($: Root, text: cheerio.Cheerio<AnyNode>): string[] =>
  text
    .find(".ui-tooltip-text")
    .toArray()
    .map((element) =>
      collapse(visibleHtmlText($(element)))
        // The note's own mark: `*`, or a number where the text has several.
        .replace(/^(?:\*+|\d{1,3}\s)\s*/u, "")
        .trim(),
    )
    .filter((note) => note.length > 0);

/** The anchor a footnote is printed under in the text's closing table. */
const NOTE_ANCHOR_PREFIX = "tresc-przypisu-";

/** An in-text reference to a footnote the closing table prints. */
const NOTE_REFERENCE = /^#tresc-przypisu-[\w-]+$/u;

/** The portal's raised-text class: footnote marks and `art. 446¹`. */
const RAISED_CLASS = "wyrok_indeks_gorny";

/** Whitespace holding a line break: the export's indentation, never a word. */
const isExportWhitespace = (code: number | undefined): boolean =>
  code === 0x20 ||
  code === 0x09 ||
  code === 0x0a ||
  code === 0x0d ||
  code === 0x0c;

/** Start of the trailing export-whitespace run, when it contains a line feed. */
const trailingIndentationStart = (text: string): number | undefined => {
  let start = text.length;
  let hasLineFeed = false;
  while (start > 0) {
    const code = text.codePointAt(start - 1);
    if (!isExportWhitespace(code)) {
      break;
    }
    hasLineFeed ||= code === 0x0a;
    start -= 1;
  }
  return hasLineFeed ? start : undefined;
};

/** Elements a raised mark can sit in without leaving its line. */
const INLINE_WRAPPERS = new Set([
  "a",
  "b",
  "em",
  "font",
  "i",
  "span",
  "strong",
]);

/** Punctuation that closes onto the word before it. */
const CLOSING_PUNCTUATION = /^[)\]}.,;:!?…”’»]/u;

const isIndentation = (node: AnyNode | null): boolean =>
  node !== null && isText(node) && trailingIndentationStart(node.data) === 0;

/** `node`, or the inline wrappers it is the only content of on `side`. */
const outermostRun = (node: AnyNode, side: "prev" | "next"): AnyNode => {
  let current = node;
  while (current[side] === null) {
    const parent = current.parent;
    if (
      parent === null ||
      !isTag(parent) ||
      !INLINE_WRAPPERS.has(parent.name)
    ) {
      break;
    }
    current = parent;
  }
  return current;
};

/** A node's text where it continues the line, or `undefined` where not. */
const lineTextOf = ($: Root, node: AnyNode): string | undefined => {
  if (isText(node)) {
    return node.data;
  }
  return isTag(node) && INLINE_WRAPPERS.has(node.name)
    ? visibleHtmlText($(node))
    : undefined;
};

/**
 * The text the line prints after `node`, or `undefined` where the line
 * ends or another kind of element follows.
 */
const visibleAfter = ($: Root, node: AnyNode): string | undefined => {
  let current = outermostRun(node, "next").next;
  while (current !== null) {
    const text = lineTextOf($, current);
    if (text === undefined) {
      return undefined;
    }
    const visible = text.trim();
    if (visible.length > 0) {
      return visible;
    }
    current = outermostRun(current, "next").next;
  }
  return undefined;
};

/**
 * A raised mark against the word it belongs to. The export breaks lines
 * before and after nested runs, so `(§ 2</font> <font><font
 * class="wyrok_indeks_gorny">1</font> </font>)` would read `§ 2 ¹ )` once
 * whitespace collapses. A mark always closes onto the word before it, so
 * indentation before it is dropped; indentation after it is dropped only
 * where punctuation follows, since before a word it is the word space. A
 * space the text itself prints beside a mark (`art. 446¹ ustawy`) is not
 * indentation and stays.
 */
const tightenRaisedMark = ($: Root, mark: Element): void => {
  for (;;) {
    const before = outermostRun(mark, "prev").prev;
    if (before !== null && isIndentation(before)) {
      $(before).remove();
      continue;
    }
    if (before !== null && isText(before)) {
      const indentationStart = trailingIndentationStart(before.data);
      if (indentationStart !== undefined) {
        before.data = before.data.slice(0, indentationStart);
      }
    }
    break;
  }
  for (;;) {
    const after = outermostRun(mark, "next").next;
    const closes = CLOSING_PUNCTUATION.test(visibleAfter($, mark) ?? "");
    if (after === null || !isIndentation(after) || !closes) {
      break;
    }
    $(after).remove();
  }
};

/**
 * The footnote markers in the text, as references to the notes the closing
 * table prints. The portal opens each note from its marker in a tooltip,
 * which is removed with the other widgets; the marker stays as a link to the
 * note's own anchor, or as its bare mark where the table prints no note.
 *
 * The portal prints the mark raised and nothing else sets it apart, so on
 * the text axis a number would run into the word it follows (`K 39/16` and
 * note 1 would read `K 39/161`). The mark is therefore bracketed, `[1]`, as
 * the other sources' note references read, and the note keeps the label it
 * prints.
 */
const markFootnoteReferences = (
  $: Root,
  copy: cheerio.Cheerio<AnyNode>,
): Element[] => {
  const printed = new Set(
    copy
      .find(`a[name^="${NOTE_ANCHOR_PREFIX}"]`)
      .toArray()
      .flatMap((anchor) => {
        const name = $(anchor).attr("name");
        return name === undefined ? [] : [`#${name}`];
      }),
  );
  return copy
    .find('a[id*="tooltip"]')
    .toArray()
    .flatMap((element) => {
      const marker = $(element);
      const label = collapse(visibleHtmlText(marker));
      const href = marker.attr("href") ?? "";
      if (label.length === 0) {
        marker.remove();
        return [];
      }
      const mark = `[${label}]`;
      const reference =
        NOTE_REFERENCE.test(href) && printed.has(href)
          ? $("<a></a>").attr("href", href).text(mark)
          : $("<sup></sup>").text(mark);
      marker.replaceWith(reference);
      return reference.toArray().filter(isTag);
    });
};

/**
 * The text container without the portal's widgets: tooltip popups (their
 * footnotes are read separately) and scripts. Footnote markers become links
 * to their notes, and the portal's raised text becomes `<sup>`.
 */
const cleanTextHtml = (
  $: Root,
  text: cheerio.Cheerio<AnyNode>,
): { fragment: cheerio.Cheerio<AnyNode>; html: string } | undefined => {
  const copy = text.clone();
  copy.find(EXCLUDED_HTML_SELECTOR).remove();
  copy.find(".ui-tooltip").remove();
  const references = markFootnoteReferences($, copy);
  // A note's own mark in the closing table keeps its class, which is how
  // `footnoteOf` lifts it out as the note's label.
  const raised = copy.find(`.${RAISED_CLASS}`).toArray().filter(isTag);
  for (const element of raised) {
    element.name = "sup";
  }
  for (const mark of [...references, ...raised]) {
    tightenRaisedMark($, mark);
  }
  const html = copy.html();
  return html === null || collapse(visibleHtmlText(copy)).length === 0
    ? undefined
    : { fragment: copy, html };
};

/** How a bench is introduced: an ordinary panel, or the full court. */
const BENCH_MARKERS = [" w składzie", " w pełnym składzie"] as const;

const COURT_NAME = /^\p{Lu}[\p{L} ]{2,80}$/u;

/** `Trybunał Konstytucyjny w składzie:` → `Trybunał Konstytucyjny`. */
const benchCourt = (line: string): string | undefined => {
  for (const marker of BENCH_MARKERS) {
    const at = line.indexOf(marker);
    if (at > 0) {
      const court = line.slice(0, at);
      if (COURT_NAME.test(court)) {
        return court;
      }
    }
  }
  return undefined;
};

/**
 * The parts of a ruling after its bench is named: the operative part, the
 * reasons and the dissents, which cite other courts' benches freely.
 */
const AFTER_BENCH =
  ".wyrok_sentencja, .wyrok_uzasadnienie, .wyrok_zdanieodrebne";

/**
 * The court the text says decided: the words before `w składzie` in the
 * bench block, or, where a ruling prints no bench block, in a line before
 * its operative part that introduces one.
 */
const courtOf = (
  $: Root,
  text: cheerio.Cheerio<AnyNode>,
): string | undefined => {
  const front = text.clone();
  front.find(AFTER_BENCH).remove();
  const candidates = [
    ...front
      .find(".wyrok_sklad")
      .first()
      .find("p, td, div")
      .toArray()
      .map((element) => collapse(visibleHtmlText($(element)))),
    ...front
      .find("p, td, div")
      .toArray()
      .map((element) => collapse(visibleHtmlText($(element)))),
  ];
  for (const line of candidates) {
    const court = benchCourt(line);
    if (court !== undefined) {
      return court;
    }
  }
  return undefined;
};

/** One ruling's tab, or `null` where the page holds no tab for the id. */
export const readPlTkRuling = (
  page: ParsedPlTkPage,
  documentId: string,
): PlTkRuling | null => {
  const { $ } = page;
  const tab = byId($, `${RULING_TAB_PREFIX}${documentId}`);
  if (tab.length === 0) {
    return null;
  }
  const props = propsOf(page, tab);
  const panel = panelOf($, tab, documentId);
  const text = byId($, `tekst_${documentId}`);
  const note = collapse(
    visibleHtmlText(tab.find('div[style="margin:5px"] > span').first()),
  );
  const word = metadataUrlOf(
    byId($, `sprawaForm:tabView:pobierzDoc${documentId}`).attr("href"),
  );

  const cleanedText = text.length === 0 ? undefined : cleanTextHtml($, text);
  if (cleanedText !== undefined) {
    page.cleanedTextByDocumentId.set(documentId, cleanedText.fragment);
  }
  return {
    documentId,
    decisionForm: valueText(props.get("Rodzaj orzeczenia")),
    decisionDate: parsePolishDate(valueText(props.get("Data")) ?? ""),
    subject: valueText(props.get("Dotyczy")),
    publications: publicationsOf($, props.get("Miejsce publikacji")),
    note: note.length === 0 ? undefined : note,
    panel,
    wordDocumentUrl: word,
    footnotes: text.length === 0 ? [] : footnotesOf($, text),
    dissents: text.length === 0 ? [] : dissentsOf($, text, panel),
    courtAsPrinted: text.length === 0 ? undefined : courtOf($, text),
    textHtml: cleanedText?.html,
  };
};

// ── Text to AST ──────────────────────────────────────────

/**
 * The part of a ruling a block sits in, read off the portal's own container
 * classes rather than the wording: the Tribunal's markup names the bench, the
 * operative part, the reasons and each dissent.
 */
type Region = "front" | "panel" | "holding" | "reasoning" | "dissent";

const REGION_CLASSES = [
  ["wyrok_zdanieodrebne", "dissent"],
  ["wyrok_uzasadnienie", "reasoning"],
  ["wyrok_sentencja", "holding"],
  ["wyrok_sklad", "panel"],
] as const satisfies readonly (readonly [string, Region])[];

const REGION_ROLE = {
  front: "intro",
  panel: "panel",
  holding: "holding",
  reasoning: "argumentation",
  dissent: "dissent",
} as const satisfies Record<Region, ParagraphRole>;

/** Containers whose text is a heading, not a paragraph. */
const HEADING_CLASSES = [
  "wyrok_naglowekNumerowany",
  "wyrok_sentencja_tytul",
  "wyrok_uzasadnienie_tytul",
] as const;

/** The ruling's own title line, in the first lines of its text. */
const DECISION_TITLE =
  /^(?:WYROK|POSTANOWIENIE|UCHWAŁA|ORZECZENIE|ROZSTRZYGNIĘCIE)$/u;

const CASE_NUMBER_LINE = /^Sygn\.\s*akt\b/iu;

/** `83/A/2026`: the ruling's position in the official reports. */
const REPORT_POSITION_LINE = /^\d{1,4}\/\d{0,2}[A-Z]{1,3}\/\d{4}$/u;

const BLOCK_TAGS = new Set([
  "blockquote",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "ol",
  "p",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

const isBlock = (node: AnyNode): boolean =>
  isTag(node) && BLOCK_TAGS.has(node.tagName.toLowerCase());

const hasBlockDescendant = (node: AnyNode): boolean =>
  isTag(node) &&
  node.children.some((child) => isBlock(child) || hasBlockDescendant(child));

const hasClass = (node: AnyNode, name: string): boolean =>
  isTag(node) && (node.attribs["class"] ?? "").split(/\s+/u).includes(name);

type HeadingParts = Omit<HeadingBlock, "id" | "anchorId">;
type ParagraphParts = Omit<ParagraphBlock, "id" | "anchorId">;

type Builder = {
  blocks: Block[];
  heading: (parts: HeadingParts) => void;
  /**
   * `anchorId` is the publisher's own anchor for the block, which a link in
   * the text points at; a block without one, or whose anchor an earlier
   * block already took, gets a positional anchor.
   */
  paragraph: (parts: ParagraphParts, anchorId?: string) => void;
};

const createBuilder = (): Builder => {
  const blocks: Block[] = [];
  const anchors = new Set<string>();
  let index = 0;
  const ids = (
    prefix: string,
    anchorId?: string,
  ): { id: string; anchorId: string } => {
    index += 1;
    const anchor =
      anchorId === undefined || anchors.has(anchorId)
        ? `${prefix}-${index}`
        : anchorId;
    anchors.add(anchor);
    return { id: `b${index}`, anchorId: anchor };
  };
  return {
    blocks,
    heading: (parts) => {
      blocks.push({ ...ids("h"), ...parts });
    },
    paragraph: (parts, anchorId) => {
      blocks.push({ ...ids("p", anchorId), ...parts });
    },
  };
};

const PARAGRAPH_NUMBER = /^\d{1,5}$/u;

/**
 * The portal sets emphasis with classes on `<font>` runs rather than with
 * `<b>` or `<i>`; its raised text is `<sup>` once `cleanTextHtml` has read
 * it. A fragment link is kept only as a reference to a printed footnote.
 */
const INLINE_OPTIONS = {
  sanitizeHref: (href: string) =>
    NOTE_REFERENCE.test(href) ? href : sanitizeUrl(href),
  emphasisClasses: {
    bold: ["wyrok_wytluszczenie"],
    italic: ["wyrok_kursywa"],
  },
  superscripts: true,
} as const;

const isBlankEdge = (inline: Inline | undefined): boolean =>
  inline?.type === "line-break" ||
  (inline?.type === "text" && inline.text.trim().length === 0);

/**
 * A block's inlines with whitespace as a browser lays it out. The portal
 * exports its text hard-wrapped and indented, so the source's line breaks
 * and indentation are markup inside every paragraph and at either end of
 * it, as is a `<br>` closing a block.
 */
const walkBlockInlines = (
  $: cheerio.CheerioAPI,
  node: cheerio.Cheerio<AnyNode>,
): Inline[] => {
  const inlines = walkInlines($, node, INLINE_OPTIONS);
  let start = 0;
  let end = inlines.length;
  while (start < end && isBlankEdge(inlines[start])) {
    start += 1;
  }
  while (end > start && isBlankEdge(inlines[end - 1])) {
    end -= 1;
  }
  return collapseHtmlWhitespace(inlines.slice(start, end));
};

const FOOTNOTE_ANCHOR = /^tresc-przypisu-(?<id>.+)$/u;

/**
 * A footnote as the text's closing table prints it: the anchor the marker in
 * the text links to, the note's mark, then the note. The mark becomes the
 * note label rather than the first word of its text.
 */
const footnoteOf = (
  $: cheerio.CheerioAPI,
  node: cheerio.Cheerio<AnyNode>,
): { label: string; noteId: string; inlines: Inline[] } | null => {
  const anchor = node.find('a[name^="tresc-przypisu-"]').first();
  const noteId = FOOTNOTE_ANCHOR.exec(anchor.attr("name") ?? "")?.groups?.[
    "id"
  ];
  if (noteId === undefined) {
    return null;
  }
  const body = node.clone();
  const mark = body.find(`.${RAISED_CLASS}`).first();
  const label = collapse(visibleHtmlText(mark));
  mark.remove();
  const inlines = walkBlockInlines($, body);
  return inlines.length === 0
    ? null
    : { label: label.length === 0 ? "*" : label, noteId, inlines };
};

type Context = {
  region: Region;
  /** The container that opened `region`, to tell its first heading. */
  regionRoot: AnyNode | undefined;
  heading: boolean;
};

type EmitOptions = Context & { number?: number | undefined };

/**
 * A dissent's heading with the judges who wrote it. Most dissents print a
 * bare `Zdanie odrębne` and name their authors on the numbered line below,
 * which would leave every dissent of a ruling under the same title. That
 * line stays a paragraph, since it carries one of the Tribunal's running
 * numbers; the heading repeats its words after the printed title.
 */
const dissentHeadingInlines = (
  $: Root,
  dissent: cheerio.Cheerio<AnyNode>,
  heading: Inline[],
): Inline[] => {
  const authors = dissentAuthorsOf(dissent);
  return authors?.printedIn === "line"
    ? collapseHtmlWhitespace([
        ...heading,
        { type: "text", text: " " },
        ...walkBlockInlines($, authors.line),
      ])
    : heading;
};

/**
 * Build the ruling's blocks from its text container.
 *
 * The portal nests divs and layout tables several deep and sets emphasis
 * with `<font>` runs inside them. A block holding no other block is one
 * paragraph, and inline content sitting beside blocks is gathered into one,
 * so an emphasised run never becomes a paragraph of its own. A
 * `wyrok_akapitCaly` pairs the Tribunal's running paragraph number with its
 * text; the number is kept as the paragraph's `number`, which is what a
 * citation of the ruling points at.
 */
const buildBlocks = ($: Root, text: cheerio.Cheerio<AnyNode>): Block[] => {
  const builder = createBuilder();
  let sawTitle = false;
  // The first heading of the reasons and of each dissent opens a top-level
  // section; the numbered parts inside the reasons sit one level below.
  const openedRegions = new Set<AnyNode>();

  const emit = (node: cheerio.Cheerio<AnyNode>, options: EmitOptions): void => {
    const note = footnoteOf($, node);
    if (note !== null) {
      builder.paragraph(
        {
          type: "paragraph",
          role: "apparatus",
          note: { type: "footnote", label: note.label, noteId: note.noteId },
          inlines: note.inlines,
          plainText: collapse(inlinesToPlainText(note.inlines)),
        },
        // The anchor the marker in the text links to.
        `${NOTE_ANCHOR_PREFIX}${note.noteId}`,
      );
      return;
    }
    const inlines = walkBlockInlines($, node);
    const plainText = collapse(inlinesToPlainText(inlines));
    if (plainText.length === 0) {
      return;
    }
    const { region } = options;
    if (!sawTitle && region === "front" && DECISION_TITLE.test(plainText)) {
      sawTitle = true;
      builder.heading({
        type: "heading",
        level: 1,
        role: "decision-title",
        inlines,
        plainText,
      });
      return;
    }
    if (options.heading) {
      const root = options.regionRoot;
      const opensRegion = root !== undefined && !openedRegions.has(root);
      if (root !== undefined) {
        openedRegions.add(root);
      }
      const titled =
        opensRegion && region === "dissent"
          ? dissentHeadingInlines($, $(root), inlines)
          : inlines;
      builder.heading({
        type: "heading",
        level: opensRegion && region !== "holding" ? 1 : 2,
        role: "section-heading",
        inlines: titled,
        plainText: collapse(inlinesToPlainText(titled)),
      });
      return;
    }
    const frontRole = (): ParagraphRole => {
      if (CASE_NUMBER_LINE.test(plainText)) {
        return "case-number";
      }
      return !sawTitle || REPORT_POSITION_LINE.test(plainText)
        ? "front-matter"
        : REGION_ROLE.front;
    };
    builder.paragraph({
      type: "paragraph",
      role: region === "front" ? frontRole() : REGION_ROLE[region],
      ...(options.number === undefined ? {} : { number: options.number }),
      inlines,
      plainText,
    });
  };

  const visit = (nodes: AnyNode[], context: Context): void => {
    let run: AnyNode[] = [];
    const flush = (): void => {
      if (run.length > 0) {
        const wrapper = $("<p></p>").append(
          ...run.map((node) => $(node).clone()),
        );
        emit(wrapper, context);
      }
      run = [];
    };
    for (const node of nodes) {
      if (!isTag(node)) {
        if (isText(node)) {
          run.push(node);
        }
        continue;
      }
      const regionClass = REGION_CLASSES.find(([name]) => hasClass(node, name));
      const next: Context = {
        region: regionClass?.[1] ?? context.region,
        regionRoot: regionClass === undefined ? context.regionRoot : node,
        heading:
          context.heading ||
          HEADING_CLASSES.some((name) => hasClass(node, name)),
      };
      if (hasClass(node, "wyrok_akapitCaly")) {
        flush();
        const counted = collapse(
          visibleHtmlText($(node).children(".wyrok_akapitNr").first()),
        );
        const body = $(node).clone();
        body.children(".wyrok_akapitNr").remove();
        emit(body, {
          ...next,
          number: PARAGRAPH_NUMBER.test(counted) ? Number(counted) : undefined,
        });
        continue;
      }
      if (hasBlockDescendant(node)) {
        flush();
        visit(node.children, next);
        continue;
      }
      if (isBlock(node)) {
        flush();
        emit($(node), next);
        continue;
      }
      run.push(node);
    }
    flush();
  };

  visit(text.contents().toArray(), {
    region: "front",
    regionRoot: undefined,
    heading: false,
  });
  return builder.blocks;
};

type ParsePlTkTextInput = {
  page: ParsedPlTkPage;
  caseNumber: string;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  documentId: string;
  sourceUrl: string;
  documentUrl: string | undefined;
  textHtml: string;
};

// The pipeline checks the blocks against the portal's own case page, read
// from the stored raw (retention/sources/pl-tk.ts), not against the fragment
// this parser selected.
export const parsePlTkText = (
  input: ParsePlTkTextInput,
): { documentAst: DocumentAst; fulltext: string } => {
  const fragment =
    input.page.cleanedTextByDocumentId.get(input.documentId) ??
    panic(`Ruling ${input.documentId} was not read from its parsed page`);
  const blocks = buildBlocks(input.page.$, fragment);
  return {
    documentAst: {
      version: 1,
      source: {
        system: PL_TK_SOURCE_SYSTEM,
        documentId: input.documentId,
        webUrl: input.sourceUrl,
        printUrl: input.documentUrl ?? "",
      },
      metadata: {
        caseNumber: input.caseNumber,
        // Poland issues no ECLI.
        ecli: null,
        court: input.court,
        decisionDate: input.decisionDate ?? null,
        decisionType: input.decisionType ?? null,
        keywords: [],
        statutes: [],
      },
      blocks,
    },
    fulltext: blocks
      .map((block) => block.plainText)
      .filter((text) => text.length > 0)
      .join("\n\n"),
  };
};
