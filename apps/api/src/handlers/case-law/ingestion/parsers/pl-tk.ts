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

import * as cheerio from "cheerio";
import { type AnyNode, isTag, isText } from "domhandler";

import type {
  Block,
  DocumentAst,
  HeadingBlock,
  Inline,
  ParagraphBlock,
  ParagraphRole,
} from "@/api/handlers/case-law/document-ast";
import {
  inlinesToPlainText,
  walkInlines,
} from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";
import {
  validateAndLog,
  type ValidationResult,
} from "@/api/lib/legal-search/parsers/validate-ast";
import { sanitizeUrl } from "@/api/lib/sanitize-url";

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

// ── Page structure ───────────────────────────────────────

export type PlTkLink = { text: string; url: string };

/** One line of `Miejsce publikacji`: the citation and the links beside it. */
export type PlTkPublication = { text: string; links: PlTkLink[] };

/** One legal act of a `Przedmiot sprawy` or `Wzorce` tree, with its units. */
export type PlTkActProvisions = { act: string; provisions: string[] };

export type PlTkPanelJudge = {
  name: string;
  /** The portal's own judge id (`Szukaj?sedzia=`), where it links one. */
  judgeId: string | undefined;
  /** `przewodniczący`, `sprawozdawca`; empty for an ordinary member. */
  functions: string[];
};

/** One dissenting opinion appended to the ruling's text. */
export type PlTkDissent = {
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
  wordDocumentUrl: string | undefined;
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

/** Ids JSF writes with colons; an attribute selector needs no escaping. */
const byId = ($: Root, id: string): cheerio.Cheerio<AnyNode> =>
  $(`[id="${id}"]`);

const propName = (prop: cheerio.Cheerio<AnyNode>): string | undefined => {
  const name = collapse(prop.children(".name").first().text());
  return name.length === 0 ? undefined : name;
};

/**
 * The `.prop` rows directly under a record container, keyed by label. The
 * ruling tab repeats its record in a `Metryka orzeczenia` accordion; only the
 * first occurrence of a label is read, which is the tab's own.
 */
const propsOf = (
  $: Root,
  container: cheerio.Cheerio<AnyNode>,
): Map<string, cheerio.Cheerio<AnyNode>> => {
  const props = new Map<string, cheerio.Cheerio<AnyNode>>();
  container.find(".prop").each((_, element) => {
    const prop = $(element);
    const name = propName(prop);
    if (name !== undefined && !props.has(name)) {
      props.set(name, prop.children(".value").first());
    }
  });
  return props;
};

const valueText = (
  value: cheerio.Cheerio<AnyNode> | undefined,
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const text = collapse(value.text());
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
        .map((element) => collapse($(element).text()))
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
        collapse($(element).find(".ui-panel-title").first().text()) === title,
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
        .map((element) => collapse($(element).text()))
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
        node.children(".ui-treenode-content").find(".ui-treenode-label").text(),
      );
      const provisions = node
        .children(".ui-treenode-children")
        .children("li")
        .toArray()
        .map((child) =>
          collapse(
            $(child)
              .children(".ui-treenode-content")
              .find(".ui-treenode-label")
              .text(),
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

/** The case record, or `null` for a page that is not a case page. */
export const readPlTkCasePage = (html: string): PlTkCasePage | null => {
  const $ = cheerio.load(html);
  const metryka = byId($, METRYKA_ID);
  if (metryka.length === 0) {
    return null;
  }
  const props = propsOf($, metryka);
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
          const url = absoluteUrl($(element).attr("href"));
          const text = collapse($(element).text());
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
export const listPlTkPageFields = (html: string): string[] => {
  const $ = cheerio.load(html);
  const scope = $('[id="sprawaForm:tabView"]');
  const names = new Set<string>();
  scope.find(".prop").each((_, element) => {
    const name = propName($(element));
    if (name !== undefined) {
      names.add(name);
    }
  });
  scope
    .find(".ui-panel-title, .ui-datatable-header, .ui-datalist-header")
    .each((_, element) => {
      const name = collapse($(element).text());
      if (name.length > 0) {
        names.add(name);
      }
    });
  return [...names];
};

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
          const url = absoluteUrl($(anchor).attr("href"));
          return url === undefined
            ? []
            : [{ text: collapse($(anchor).text()), url }];
        });
      // The Dz.U./M.P. line prints its register links (ISAP, RCL) as cells
      // of their own; the citation is what the first cell says.
      const first = cells.find("td").first();
      const nested = first.find("td").first();
      const text = collapse((nested.length > 0 ? nested : first).text());
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
      const name = collapse(cells.eq(0).text());
      if (name.length === 0) {
        return [];
      }
      const href = cells.eq(0).find("a").attr("href") ?? "";
      const functions = collapse(cells.eq(1).text())
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

/**
 * The authors line of each `wyrok_zdanieodrebne` block: the first numbered
 * line after the `Zdanie odrębne` heading, which names the judge or judges
 * (`sędziego TK …`, `sędziów TK … i …`).
 */
const dissentsOf = (
  $: Root,
  text: cheerio.Cheerio<AnyNode>,
  panel: PlTkPanelJudge[],
): PlTkDissent[] =>
  text
    .find(".wyrok_zdanieodrebne")
    .toArray()
    .map((element) => {
      const lines = $(element)
        .find(".wyrok_akapitNumerowany")
        .toArray()
        .map((line) => collapse($(line).text()))
        .filter((line) => line.length > 0);
      const authorsAsPrinted =
        lines.find((line) => /^sędzi/iu.test(line)) ?? lines.at(0) ?? "";
      return {
        authorsAsPrinted,
        judges: dissentJudges(authorsAsPrinted, panel),
      };
    });

const footnotesOf = ($: Root, text: cheerio.Cheerio<AnyNode>): string[] =>
  text
    .find(".ui-tooltip-text")
    .toArray()
    .map((element) =>
      collapse($(element).text())
        // The note's own mark: `*`, or a number where the text has several.
        .replace(/^(?:\*+|\d{1,3}\s)\s*/u, "")
        .trim(),
    )
    .filter((note) => note.length > 0);

/**
 * The text container without the portal's widgets: tooltip popups (their
 * footnotes are read separately), the footnote markers that open them and
 * scripts.
 */
const cleanTextHtml = (
  $: Root,
  text: cheerio.Cheerio<AnyNode>,
): string | undefined => {
  const copy = text.clone();
  copy.find("script, .ui-tooltip").remove();
  copy.find('a[id*="tooltip"]').remove();
  const html = copy.html();
  return html === null || collapse($(copy).text()).length === 0
    ? undefined
    : html;
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
      .map((element) => collapse($(element).text())),
    ...front
      .find("p, td, div")
      .toArray()
      .map((element) => collapse($(element).text())),
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
  html: string,
  documentId: string,
): PlTkRuling | null => {
  const $ = cheerio.load(html);
  const tab = byId($, `${RULING_TAB_PREFIX}${documentId}`);
  if (tab.length === 0) {
    return null;
  }
  const props = propsOf($, tab);
  const panel = panelOf($, tab, documentId);
  const text = byId($, `tekst_${documentId}`);
  const note = collapse(
    tab.find('div[style="margin:5px"] > span').first().text(),
  );
  const word = absoluteUrl(
    byId($, `sprawaForm:tabView:pobierzDoc${documentId}`).attr("href"),
  );

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
    textHtml: text.length === 0 ? undefined : cleanTextHtml($, text),
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
  paragraph: (parts: ParagraphParts) => void;
};

const createBuilder = (): Builder => {
  const blocks: Block[] = [];
  let index = 0;
  const ids = (prefix: string): { id: string; anchorId: string } => {
    index += 1;
    return { id: `b${index}`, anchorId: `${prefix}-${index}` };
  };
  return {
    blocks,
    heading: (parts) => {
      blocks.push({ ...ids("h"), ...parts });
    },
    paragraph: (parts) => {
      blocks.push({ ...ids("p"), ...parts });
    },
  };
};

const PARAGRAPH_NUMBER = /^\d{1,5}$/u;

/**
 * The portal sets emphasis with classes on `<font>` runs rather than with
 * `<b>` or `<i>`.
 */
const INLINE_OPTIONS = {
  sanitizeHref: sanitizeUrl,
  emphasisClasses: {
    bold: ["wyrok_wytluszczenie"],
    italic: ["wyrok_kursywa"],
  },
} as const;

const isBlankText = (inline: Inline | undefined): boolean =>
  inline?.type === "text" && inline.text.trim().length === 0;

/**
 * A block's inlines without the markup's indentation at either end. The
 * portal indents every run, so a paragraph opening with an emphasised run
 * would otherwise open with a whitespace run instead of the emphasis.
 */
const walkBlockInlines = (
  $: cheerio.CheerioAPI,
  node: cheerio.Cheerio<AnyNode>,
): Inline[] => {
  const inlines = walkInlines($, node, INLINE_OPTIONS);
  let start = 0;
  let end = inlines.length;
  while (start < end && isBlankText(inlines[start])) {
    start += 1;
  }
  while (end > start && isBlankText(inlines[end - 1])) {
    end -= 1;
  }
  return inlines.slice(start, end);
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
  const mark = body.find(".wyrok_indeks_gorny").first();
  const label = collapse(mark.text());
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
const buildBlocks = (textHtml: string): Block[] => {
  const $ = cheerio.load(textHtml, null, false);
  const builder = createBuilder();
  let sawTitle = false;
  // The first heading of the reasons and of each dissent opens a top-level
  // section; the numbered parts inside the reasons sit one level below.
  const openedRegions = new Set<AnyNode>();

  const emit = (node: cheerio.Cheerio<AnyNode>, options: EmitOptions): void => {
    const note = footnoteOf($, node);
    if (note !== null) {
      builder.paragraph({
        type: "paragraph",
        role: "apparatus",
        note: { type: "footnote", label: note.label, noteId: note.noteId },
        inlines: note.inlines,
        plainText: collapse(inlinesToPlainText(note.inlines)),
      });
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
      builder.heading({
        type: "heading",
        level: opensRegion && region !== "holding" ? 1 : 2,
        role: "section-heading",
        inlines,
        plainText,
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
          $(node).children(".wyrok_akapitNr").first().text(),
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

  visit($.root().contents().toArray(), {
    region: "front",
    regionRoot: undefined,
    heading: false,
  });
  return builder.blocks;
};

type ParsePlTkTextInput = {
  caseNumber: string;
  court: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  documentId: string;
  sourceUrl: string;
  documentUrl: string | undefined;
  textHtml: string;
};

/**
 * Check the blocks against the text they were built from. The reference is
 * the portal's own markup, so text the builder failed to emit shows up as
 * lost content rather than being absent from both sides.
 */
export const validatePlTkBlocks = (
  caseNumber: string,
  textHtml: string,
  blocks: Block[],
): ValidationResult =>
  validateAndLog(
    { parser: "pl-tk", caseNumber },
    `<body>${textHtml}</body>`,
    blocks,
  );

export const parsePlTkText = (
  input: ParsePlTkTextInput,
): { documentAst: DocumentAst; fulltext: string } => {
  const blocks = buildBlocks(input.textHtml);
  validatePlTkBlocks(input.caseNumber, input.textHtml, blocks);
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
