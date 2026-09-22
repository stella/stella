/**
 * Hungarian courts (Bírósági Határozatok Gyűjteménye) decision parser.
 *
 * One parser over both of the collection's eras. The publisher serves
 * decisions born in the current system as DOCX and the 2020-09-29 migration of
 * the old collection as RTF, so the adapter reads each with its own reader —
 * `parseDocx` from `@stll/folio-core/server`, `readRtf` from
 * `lib/legal-search/parsers/rtf-reader` — and both answer in folio's document
 * model. Everything below that point is one reading of one shape.
 *
 * What the two eras do not share is structure. A legacy RTF states the
 * publisher's own typesetting: the decision kind is centred and bold, the
 * anonymised spans carry a colour, the court's name opens the page. A current
 * DOCX states nothing at all — no styles, no bold, no colour, every paragraph
 * left-aligned — so its sections can only be read off the wording (rule 9's
 * "prefer the publisher's structure" has nothing to prefer here, and says so
 * in this file rather than in a heading table nobody can find).
 *
 * Which is why classification is a promotion, never a filter (rule 10): a line
 * this parser does not recognise is emitted as a plain paragraph in document
 * order, and only a line it does recognise gains a heading or a role.
 */

import { panic } from "better-result";

import type {
  BlockContent,
  Document as FolioDocument,
  Paragraph as FolioParagraph,
  Run as FolioRun,
  RunContent as FolioRunContent,
  Table as FolioTable,
  TextFormatting,
} from "@stll/docx-core/model";
import { collapseSpacedLetters } from "@stll/text-normalize";

import type {
  Block,
  DocumentAst,
  HeadingBlock,
  Inline,
  ParagraphBlock,
  ParagraphRole,
  TableBlock,
  TableCell,
} from "@/api/handlers/case-law/document-ast";
import {
  inlinesToPlainText,
  stripInlinePrefix,
} from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";
import { sectionsFromAst } from "@/api/handlers/case-law/ingestion/sections-from-ast";
import { DECISION_JUDGE_ROLE } from "@/api/handlers/case-law/judges/consts";
import { arrayOrEmpty } from "@/api/lib/array";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import type { DecisionJudgeInput } from "@/api/lib/legal-search/ingestion-types";
import {
  buildValidationHtml,
  validateAndLog,
} from "@/api/lib/legal-search/parsers/validate-ast";

/** Publisher recorded on the AST, so a stored document names where it came from. */
const HU_BHGY_SOURCE_SYSTEM = "eakta.birosag.hu";

const HU_BHGY_PARSER = "hu-bhgy";

// ── The document as lines ────────────────────────────────

/** One run of characters sharing a weight and an anonymisation state. */
type DocRun = {
  readonly text: string;
  readonly bold: boolean;
  readonly italic: boolean;
  /** The publisher set this span in a colour: the legacy era's anon marker. */
  readonly colored: boolean;
};

type DocLine = {
  readonly runs: readonly DocRun[];
  readonly text: string;
  readonly centered: boolean;
  /** The note this line belongs to, where it is a footnote's text. */
  readonly note?: { readonly label: string; readonly noteId: string };
};

type DocTable = { readonly rows: readonly (readonly DocLine[])[] };

type DocItem =
  | { readonly type: "line"; readonly line: DocLine }
  | { readonly type: "table"; readonly table: DocTable };

/** The characters one run item contributes to the document's text. */
const runContentText = (item: FolioRunContent): string => {
  switch (item.type) {
    case "text":
      return item.text;
    case "tab":
      return "\t";
    case "break":
      return "\n";
    // Verbatim-preserved markup folio does not model. Its `text` is what the
    // markup puts on the line (a `w:ruby` base is a word of the decision), so
    // the extraction takes it rather than dropping the characters.
    case "preservedXml":
      return item.text;
    // Carry no characters of their own: a symbol, a note mark, a field's own
    // instruction text, a hyphen the layout inserted, a drawing or a shape all
    // reach the text through the runs around them.
    case "symbol":
    case "footnoteRef":
    case "endnoteRef":
    case "fieldChar":
    case "instrText":
    case "softHyphen":
    case "noBreakHyphen":
    case "renderedPageBreak":
    case "drawing":
    case "shape":
      return "";
    default:
      item satisfies never;
      return panic(`Unhandled run content: ${JSON.stringify(item)}`);
  }
};

const runsOf = (paragraph: FolioParagraph): DocRun[] => {
  const runs: DocRun[] = [];
  const pushRun = (run: FolioRun): void => {
    const formatting: TextFormatting | undefined = run.formatting;
    const text = run.content.map(runContentText).join("");
    if (text.length === 0) {
      return;
    }
    runs.push({
      text,
      bold: formatting?.bold === true,
      italic: formatting?.italic === true,
      colored:
        formatting?.color !== undefined && formatting.color.auto !== true,
    });
  };

  for (const item of paragraph.content) {
    if (item.type === "run") {
      pushRun(item);
      continue;
    }
    if (item.type === "hyperlink") {
      for (const child of item.children) {
        if (child.type === "run") {
          pushRun(child);
        }
      }
    }
    // Bookmarks, comment anchors and tracked-change markers carry no text.
  }
  return runs;
};

const lineOf = (paragraph: FolioParagraph, note?: DocLine["note"]): DocLine => {
  const runs = runsOf(paragraph);
  const alignment = paragraph.formatting?.alignment;
  return {
    runs,
    // Trailing breaks are how this publisher's DOCX ends every paragraph; they
    // are the paragraph mark written twice, not a blank line in the decision.
    // `trimEnd` rather than `/\s+$/`, which re-scans the tail from every start
    // position; it drops the same characters, no-break space included.
    text: runs
      .map(({ text }) => text)
      .join("")
      .trimEnd(),
    centered: alignment === "center",
    ...(note === undefined ? {} : { note }),
  };
};

const tableOf = (table: FolioTable): DocTable => ({
  rows: table.rows.map((row) =>
    row.cells.map((cell) => {
      const paragraphs = cell.content.filter(
        (item): item is FolioParagraph => item.type === "paragraph",
      );
      const lines = paragraphs.map((item) => lineOf(item));
      const text = lines
        .map(({ text: cellText }) => cellText)
        .filter((cellText) => cellText.length > 0)
        .join("\n");
      return {
        runs: lines.flatMap(({ runs }) => runs),
        text,
        centered: lines.every(({ centered }) => centered),
      };
    }),
  ),
});

/** Walk folio's blocks into the flat line-and-table sequence this parser reads. */
const itemsOf = (content: readonly BlockContent[]): DocItem[] =>
  content.flatMap((block): DocItem[] => {
    switch (block.type) {
      case "paragraph":
        return [{ type: "line", line: lineOf(block) }];
      case "table":
        return [{ type: "table", table: tableOf(block) }];
      case "blockSdt":
        // A content control is a wrapper; its children are the document's.
        return itemsOf(block.content);
      // No line of the decision: a preserved block is opaque markup folio does
      // not model and holds no text, and a bookmark marker is a position. This
      // parser reads text, so it skips all three rather than round-tripping
      // them.
      case "preservedBlock":
      case "bookmarkStart":
      case "bookmarkEnd":
        return [];
      default:
        block satisfies never;
        return panic(`Unhandled folio block: ${JSON.stringify(block)}`);
    }
  });

// ── Hungarian vocabulary ─────────────────────────────────

/**
 * A line's text as the vocabulary below is written: spaced capitals collapsed
 * (`Í T É L E T E T :` is one word in this collection), whitespace squeezed,
 * trailing punctuation dropped, lower-cased for Hungarian.
 */
const HEADING_TRAILING_MARKS = new Set([":", "!", "."]);

/**
 * Drop the punctuation a heading ends with. A scan, because `/[:!.]+$/` has no
 * anchor at its start and re-reads the tail from every position in the line.
 */
const withoutTrailingMarks = (text: string): string => {
  let end = text.length;
  while (end > 0 && HEADING_TRAILING_MARKS.has(text.charAt(end - 1))) {
    end -= 1;
  }
  return text.slice(0, end);
};

const headingKey = (text: string): string =>
  withoutTrailingMarks(
    collapseSpacedLetters(text)
      .replaceAll(/[\s ]+/gu, " ")
      .trim(),
  ).toLocaleLowerCase("hu-HU");

/** Where in the document the walk currently is, which decides a body role. */
type Region = "front" | "operative" | "reasoning" | "apparatus" | "closing";

/**
 * The section headings the collection prints, and the depth each sits at.
 *
 * Level 1 cuts a section (`sectionsFromAst`); level 2 is a title inside one.
 * Written as the publisher writes them, because a DOCX from this source states
 * no structure at all and the wording is the only thing left to read.
 */
type SectionHeading = {
  /** The heading as `headingKey` writes it. */
  readonly key: string;
  /** 1 cuts a section (`sectionsFromAst`); 2 is a title inside one. */
  readonly level: 1 | 2;
  /** The region this heading opens, where it opens one. */
  readonly region?: Region;
};

const SECTION_HEADINGS = [
  { key: "rendelkező rész", level: 1, region: "operative" },
  { key: "indokolás", level: 1, region: "reasoning" },
  { key: "a döntés elvi tartalma", level: 1, region: "apparatus" },
  {
    key: "alkalmazott jogszabályok és joggyakorlat",
    level: 1,
    region: "apparatus",
  },
  { key: "záradék", level: 1, region: "closing" },
  { key: "a felülvizsgálat alapjául szolgáló tényállás", level: 2 },
  { key: "a kereseti kérelem és az alperes védekezése", level: 2 },
  { key: "az első- és másodfokú ítélet", level: 2 },
  { key: "a felülvizsgálati kérelem és ellenkérelem", level: 2 },
] as const satisfies readonly SectionHeading[];

/** A heading line's own length; past it, a match is a sentence, not a title. */
const HEADING_LINE_MAX = 60;

/**
 * The heading a line states, or `null`.
 *
 * Equality first. The `endsWith` fallback is for one observed defect and is
 * bounded by the line's length: the collection holds decisions whose heading
 * carries a stray keystroke in front of it (`Re     Rendelkező rész`), and a
 * document with a typo is still the document, so its section is still cut.
 */
const sectionHeadingIn = (key: string): SectionHeading | null =>
  SECTION_HEADINGS.find(
    (heading) =>
      key === heading.key ||
      (key.length <= HEADING_LINE_MAX && key.endsWith(` ${heading.key}`)),
  ) ?? null;

/**
 * The operative part's own introduction, which courts set as a centred, spaced
 * line rather than as a heading: `Í T É L E T E T :`, `v é g z é s t :`.
 *
 * Accusative only. The nominative is what the title block prints above the
 * header (`A Kúria / mint felülvizsgálati bíróság / végzés`), and reading that
 * as the operative part closes the header before any of its labels are seen.
 * In the current era the operative part opens with `Rendelkező rész`, which is
 * a section heading.
 */
const OPERATIVE_INTRODUCTIONS = new Set(["ítéletet", "végzést", "határozatot"]);

/** The republic's formula, printed above the operative part in the legacy era. */
const REPUBLIC_FORMULAE = new Set([
  "a magyar köztársaság nevében",
  "magyarország nevében",
]);

/**
 * The labels the current era prints down the left of a decision's header, the
 * role each line carries, and the forms courts write them in.
 *
 * `forms` exists because the same label is printed for one party and for
 * several (`Az alperes:`, `Az alperesek képviselője:`), and a match is the
 * longest form that opens the line: matching the first form that fits would
 * read `Az alperesek képviselője` as a party line, since `az alperes` opens it
 * too. The inventory in the adapter names these labels, so both the parser's
 * roles and the source-field census are read off this one list.
 */
const HEADER_LABELS = [
  {
    label: "Az ügy száma",
    role: "case-number",
    forms: ["az ügy száma"],
  },
  {
    label: "A tanács tagjai",
    role: "panel",
    forms: ["a tanács tagjai"],
  },
  {
    label: "A felperes képviselője",
    role: "counsel",
    forms: ["a felperes képviselője", "a felperesek képviselője"],
  },
  {
    label: "Az alperes képviselője",
    role: "counsel",
    forms: ["az alperes képviselője", "az alperesek képviselője"],
  },
  {
    label: "A kérelmező képviselője",
    role: "counsel",
    forms: ["a kérelmező képviselője", "a kérelmezők képviselője"],
  },
  {
    label: "A felperes",
    role: "parties",
    forms: ["a felperes", "a felperesek"],
  },
  {
    label: "Az alperes",
    role: "parties",
    forms: ["az alperes", "az alperesek"],
  },
  {
    label: "A kérelmező",
    role: "parties",
    forms: ["a kérelmező", "a kérelmezők"],
  },
  {
    label: "A kérelmezett",
    role: "parties",
    forms: ["a kérelmezett", "a kérelmezettek"],
  },
  {
    label: "A terhelt",
    role: "parties",
    forms: ["a terhelt", "a terheltek"],
  },
  {
    label: "A per tárgya",
    role: "front-matter",
    forms: ["a per tárgya"],
  },
  {
    label: "Az ügy tárgya",
    role: "front-matter",
    forms: ["az ügy tárgya"],
  },
  {
    label: "A felülvizsgálati kérelmet benyújtó fél",
    role: "front-matter",
    forms: ["a felülvizsgálati kérelmet benyújtó fél"],
  },
  {
    label: "Az elsőfokú bíróság neve",
    role: "history",
    forms: ["az elsőfokú bíróság neve"],
  },
  {
    label: "A másodfokú bíróság neve",
    role: "history",
    forms: ["a másodfokú bíróság neve"],
  },
  {
    label: "A harmadfokú bíróság neve",
    role: "history",
    forms: ["a harmadfokú bíróság neve"],
  },
] as const satisfies readonly {
  label: string;
  role: ParagraphRole;
  forms: readonly string[];
}[];

/** A label of the decision header, spelled as the adapter's inventory names it. */
export type HuBhgyHeaderLabel = (typeof HEADER_LABELS)[number]["label"];

type HeaderLabelMatch = {
  readonly label: HuBhgyHeaderLabel;
  readonly role: ParagraphRole;
  /** What the line states, with the label and its colon removed. */
  readonly value: string;
};

/**
 * The header label a line opens with, or `null`.
 *
 * Longest form wins, so a plural line is read as the label it is rather than
 * as the shorter one it happens to contain.
 */
const huBhgyHeaderLabelIn = (text: string): HeaderLabelMatch | null => {
  const key = headingKey(text);
  let best: {
    label: HuBhgyHeaderLabel;
    role: ParagraphRole;
    length: number;
  } | null = null;
  for (const { label, role, forms } of HEADER_LABELS) {
    for (const form of forms) {
      if (
        key.startsWith(form) &&
        (best === null || form.length > best.length)
      ) {
        best = { label, role, length: form.length };
      }
    }
  }
  if (best === null) {
    return null;
  }
  const colon = text.indexOf(":");
  return {
    label: best.label,
    role: best.role,
    value: (colon === -1 ? "" : text.slice(colon + 1)).trim(),
  };
};

/**
 * How the bench states each of its members, longest form first.
 *
 * The court prints the part after the name — `Dr. … a tanács elnöke`,
 * `Dr. … előadó bíró`, `Dr. … bíró` — in the header's panel block and again
 * in the signature line, so one suffix table reads both.
 */
const BENCH_ROLES = [
  { suffix: "a tanács elnöke", role: DECISION_JUDGE_ROLE.PRESIDING },
  { suffix: "tanácselnök", role: DECISION_JUDGE_ROLE.PRESIDING },
  { suffix: "előadó bíró", role: DECISION_JUDGE_ROLE.RAPPORTEUR },
  { suffix: "bíró", role: DECISION_JUDGE_ROLE.PANEL_MEMBER },
] as const;

/** Members of one panel line, as the court separates them. */
const PANEL_MEMBER_SEPARATOR = /[/,;]/u;

/** `s.k.`, the signed-in-the-original mark, which is not part of a name. */
const SIGNED_IN_ORIGINAL = /\bs\.\s?k\.\s*$/iu;

type BenchRoleMatch = {
  readonly role: DecisionJudgeInput["role"];
  /** The name with the role words and the signature mark taken off. */
  readonly nameAsPrinted: string;
};

/**
 * The bench part one panel segment states, or `null` where it states none.
 *
 * Longest suffix wins: `előadó bíró` ends in `bíró` too, and the rapporteur is
 * the one the reader cares about most.
 */
const huBenchRoleIn = (segment: string): BenchRoleMatch | null => {
  const text = segment.replaceAll(/[\s\u00a0]+/gu, " ").trim();
  const key = text.toLocaleLowerCase("hu-HU");
  let best: { suffix: string; role: DecisionJudgeInput["role"] } | null = null;
  for (const candidate of BENCH_ROLES) {
    if (
      key.endsWith(candidate.suffix) &&
      (best === null || candidate.suffix.length > best.suffix.length)
    ) {
      best = candidate;
    }
  }
  if (best === null) {
    return null;
  }
  const nameAsPrinted = text
    .slice(0, text.length - best.suffix.length)
    .replace(SIGNED_IN_ORIGINAL, "")
    .trim();
  return nameAsPrinted.length === 0 ? null : { role: best.role, nameAsPrinted };
};

/**
 * The bench the panel block names.
 *
 * The court writes one member per line or several on one, so each line is cut
 * on the separators it uses before the part is read off the end. A segment
 * stating no part is dropped rather than guessed at: a name with no role is
 * not a judge this decision named in a role.
 */
const huPanelJudgesFrom = (
  lines: readonly string[],
): readonly DecisionJudgeInput[] => {
  const judges: DecisionJudgeInput[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    for (const segment of line.split(PANEL_MEMBER_SEPARATOR)) {
      const bench = huBenchRoleIn(segment);
      if (bench === null) {
        continue;
      }
      const key = `${bench.role}:${bench.nameAsPrinted}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      judges.push(bench);
    }
  }
  return judges;
};

const KIADMANY = "a kiadmány hiteléül";

/** `Budapest, 2025. október 1.` and `Budapest, 2024.05.06.` */
const HUNGARIAN_MONTHS = [
  "január",
  "február",
  "március",
  "április",
  "május",
  "június",
  "július",
  "augusztus",
  "szeptember",
  "október",
  "november",
  "december",
] as const;

const MONTH_NAMES = HUNGARIAN_MONTHS.join("|");

/** The month each name stands for, one-based, looked up rather than searched. */
const MONTH_NUMBERS = new Map<string, number>(
  HUNGARIAN_MONTHS.map((name, index) => [name, index + 1]),
);

const SPELLED_DATE = new RegExp(
  String.raw`(?<year>\d{4})\.\s*(?<month>${MONTH_NAMES})\s*(?<day>\d{1,2})\.`,
  "iu",
);

const NUMERIC_DATE =
  /(?<year>\d{4})\.\s*(?<month>\d{1,2})\.\s*(?<day>\d{1,2})\./u;

const pad = (value: number): string => String(value).padStart(2, "0");

/**
 * The decision's own date, read off a closing line.
 *
 * The listing states only `HatarozatEve`, the year, so a date derived from it
 * would be a guess wearing a day. Where the document prints none, the decision
 * carries no date rather than a wrong one.
 */
export const huDecisionDateFrom = (line: string): string | undefined => {
  const spelled = SPELLED_DATE.exec(line)?.groups;
  if (spelled !== undefined) {
    const month = MONTH_NUMBERS.get(
      (spelled["month"] ?? "").toLocaleLowerCase("hu-HU"),
    );
    if (month !== undefined) {
      return `${spelled["year"]}-${pad(month)}-${pad(Number(spelled["day"]))}`;
    }
  }
  const numeric = NUMERIC_DATE.exec(line)?.groups;
  if (numeric === undefined) {
    return undefined;
  }
  const month = Number(numeric["month"]);
  const day = Number(numeric["day"]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
    ? `${numeric["year"]}-${pad(month)}-${pad(day)}`
    : undefined;
};

/**
 * A place-and-date line: `Budapest, 2025. október 1.` The place is the court's
 * seat, so the comma is what tells this line from a sentence ending in a date.
 */
const CLOSING_LINE = /^\p{Lu}[\p{L}\-\s]{2,30},\s*\d{4}\./u;

/**
 * The decision kinds this collection prints, lowercase, as rule 8 requires.
 * Longest first, so `jogegységi határozat` is not read as `határozat`.
 */
const HU_DECISION_TYPES = [
  "jogegységi határozat",
  "kollégiumi állásfoglalás",
  "kollégiumi vélemény",
  "elvi határozat",
  "ítélet",
  "végzés",
  "határozat",
] as const;

/**
 * The decision's kind, from the title lines the document opens with.
 *
 * The publisher prints it in the accusative under the operative part
 * (`ítéletet`, `végzést`) and in the possessive in the title block
 * (`ítélete`), so the stem is what matches and the stored value is the
 * dictionary form.
 */
export const huDecisionTypeFrom = (
  lines: readonly string[],
): string | undefined => {
  for (const line of lines) {
    const key = headingKey(line);
    const matched = HU_DECISION_TYPES.find(
      (type) => key === type || key.startsWith(`${type}e`),
    );
    if (matched !== undefined) {
      return matched;
    }
    const accusative = HU_DECISION_TYPES.find((type) =>
      OPERATIVE_INTRODUCTIONS.has(key)
        ? key.startsWith(type.slice(0, 4))
        : false,
    );
    if (accusative !== undefined) {
      return accusative;
    }
  }
  return undefined;
};

/** `Az ügy száma:      Gfv.VI.30.091/2025/4.` */
const DOCKET_LABEL = "az ügy száma:";

/**
 * The legacy era's own docket line, `Pf.III.20.723/2009/5. szám`.
 *
 * Every segment is bounded and terminated by a character the segment class
 * excludes, so there is one way to split the number and nothing to backtrack
 * over: `[\p{L}\d./]*\d` let the class and the digit after it match the same
 * characters, which is super-linear on a long line.
 */
const LEGACY_DOCKET_LINE =
  /^(?<docket>[\p{Lu}\p{Ll}]{1,5}\.(?:[\p{L}\d]{1,6}\.){0,4}\d{1,6}\/\d{4}\/\d{1,4})\.?\s*sz[áa]m/u;

/** The docket a labelled line states, with the sentence's full stop dropped. */
const docketAfterLabel = (line: string): string | undefined => {
  const head = line.slice(0, DOCKET_LABEL.length).toLocaleLowerCase("hu-HU");
  if (head !== DOCKET_LABEL) {
    return undefined;
  }
  const docket = line.slice(DOCKET_LABEL.length).trim();
  if (docket.length === 0) {
    return undefined;
  }
  return docket.endsWith(".") ? docket.slice(0, -1) : docket;
};

export const huDocketFrom = (lines: readonly string[]): string | undefined => {
  for (const line of lines) {
    const trimmed = line.trim();
    const labelled = docketAfterLabel(trimmed);
    if (labelled !== undefined) {
      return labelled;
    }
    const legacy = LEGACY_DOCKET_LINE.exec(trimmed)?.groups?.["docket"];
    if (legacy !== undefined) {
      return legacy;
    }
  }
  return undefined;
};

// ── Anonymisation ────────────────────────────────────────

/**
 * The placeholder vocabulary the publisher substitutes for personal data under
 * Bszi. 166. §, in both of its spellings: the current era's numbered tokens
 * (`név1`, `cég2`, `Terhelt1`) and the legacy era's spelled-out forms
 * (`alperes neve (címe)`, `terhelt születési helye`).
 *
 * Matched on the text rather than on markup because only one era marks them at
 * all: a DOCX places each placeholder in its own run and marks nothing, an RTF
 * sets them in a colour whose table entry is plain black. The colour is kept
 * too — a coloured run is anonymised whatever its words — so the token list is
 * the floor, not the whole rule.
 */
const PLACEHOLDER_STEMS = [
  "név",
  "cím",
  "cég",
  "dátum",
  "szám",
  "felperes",
  "alperes",
  "terhelt",
  "vádlott",
  "gyanúsított",
  "kérelmező",
  "kérelmezett",
  "tanú",
  "sértett",
  "adószám",
  "bankszámlaszám",
  "email",
  "telefonszám",
] as const;

/** `név1`, `Terhelt1`, `Gyanúsított 1.`, `cég12` */
const NUMBERED_PLACEHOLDER = new RegExp(
  String.raw`\b(?:${PLACEHOLDER_STEMS.join("|")})\s?\d{1,3}\.?`,
  "giu",
);

/**
 * `alperes neve (címe)`, `I.rendű felperes neve`, `város neve`,
 * `terhelt születési helye`: the legacy era spells the field out in the
 * possessive instead of numbering it.
 */
const SPELLED_PLACEHOLDER =
  /\b(?:[IVX]+\.\s?rendű\s+)?(?:felperes|alperes|terhelt|vádlott|gyanúsított|kérelmező|kérelmezett|tanú|sértett|város|község|utca|munkáltató|védő)\s+(?:születési\s+)?(?:neve|címe|helye|ideje|lakcíme|székhelye|anyja\s+neve)/giu;

type AnonSpan = { readonly start: number; readonly end: number };

const anonSpansIn = (text: string): AnonSpan[] => {
  const spans: AnonSpan[] = [];
  for (const pattern of [NUMBERED_PLACEHOLDER, SPELLED_PLACEHOLDER]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      spans.push({ start, end: start + match[0].length });
    }
  }
  return spans.sort((left, right) => left.start - right.start);
};

/** Split one run's text at its placeholder spans, marking each as anonymized. */
const textInlinesOf = (run: DocRun): Inline[] => {
  if (run.colored) {
    // The publisher coloured the whole run; every character in it is redacted.
    return [{ type: "text", text: run.text, anonymized: true }];
  }
  const spans = anonSpansIn(run.text);
  if (spans.length === 0) {
    return [{ type: "text", text: run.text }];
  }
  const inlines: Inline[] = [];
  let cursor = 0;
  for (const { start, end } of spans) {
    if (start < cursor) {
      continue;
    }
    if (start > cursor) {
      inlines.push({ type: "text", text: run.text.slice(cursor, start) });
    }
    inlines.push({
      type: "text",
      text: run.text.slice(start, end),
      anonymized: true,
    });
    cursor = end;
  }
  if (cursor < run.text.length) {
    inlines.push({ type: "text", text: run.text.slice(cursor) });
  }
  return inlines;
};

const inlinesOf = (runs: readonly DocRun[]): Inline[] =>
  runs.flatMap((run) => {
    const text = textInlinesOf(run);
    const italic: Inline[] = run.italic
      ? [{ type: "italic", children: text }]
      : text;
    return run.bold ? [{ type: "bold", children: italic }] : italic;
  });

// ── Paragraph numbers ────────────────────────────────────

/** `[1]`, `[42]`: the number the court itself cites its paragraphs by. */
const COURT_PARAGRAPH_NUMBER = /^\[(?<number>\d{1,4})\]\s*/u;

// ── Parse ────────────────────────────────────────────────

export type ParseHuBhgyInput = {
  /** The decision, as either reader answered. */
  document: FolioDocument;
  /** The docket the listing states, which stays the decision's case number. */
  listedCaseNumber: string;
  court: string;
  sourceUrl: string;
  documentUrl: string;
  documentId: string;
  /** Provisions the listing tagged, for the AST's metadata header. */
  statutes: readonly string[];
};

export type ParseHuBhgyOutput = {
  documentAst: DocumentAst;
  fulltext: string;
  sections: DecisionSection[];
  /** Read off the document; the listing states only the year. */
  decisionDate: string | undefined;
  /** Read off the title lines, lowercase Hungarian (rule 8). */
  decisionType: string | undefined;
  /** The full docket the document prints, where it differs from the listed one. */
  documentDocket: string | undefined;
  /** The instance chain the document names, as printed. */
  relatedProceedings: readonly string[];
  /** The bench, from the panel block the header labels. */
  judges: readonly DecisionJudgeInput[];
  /** Header labels the document printed, for the adapter's field inventory. */
  headerLabels: readonly HuBhgyHeaderLabel[];
  /** Control words the RTF reader did not recognise, for the parse signal. */
  readerWarnings: readonly string[];
};

/**
 * The header labels a document prints, for the adapter's field inventory.
 *
 * The same walk the parse makes, over the same matcher: a label the parse
 * reads a value from and a label the inventory declares cannot be two lists.
 */
export const huBhgyHeaderLabelsOf = (
  document: FolioDocument,
): readonly HuBhgyHeaderLabel[] => {
  const labels = new Set<HuBhgyHeaderLabel>();
  for (const item of itemsOf(document.package.document.content)) {
    if (item.type !== "line") {
      continue;
    }
    // The header ends where the first section does. Past it a sentence can
    // open with a party's name, and a label is only a label in the header.
    if (sectionHeadingIn(headingKey(item.line.text)) !== null) {
      break;
    }
    const labelled = huBhgyHeaderLabelIn(item.line.text);
    if (labelled !== null) {
      labels.add(labelled.label);
    }
  }
  return [...labels];
};

type HeadingParts = Omit<HeadingBlock, "id" | "anchorId">;
type ParagraphParts = Omit<ParagraphBlock, "id" | "anchorId">;
type TableParts = Omit<TableBlock, "id" | "anchorId">;

/**
 * One counter over every block, so ids and anchors are unique and stable for
 * the document's order. Three entry points rather than one over the union:
 * `Omit` distributes badly over `Block`, and the alternative is a cast.
 */
type BlockBuilder = {
  blocks: Block[];
  heading: (parts: HeadingParts) => void;
  paragraph: (parts: ParagraphParts) => void;
  table: (parts: TableParts) => void;
};

const createBlockBuilder = (): BlockBuilder => {
  const blocks: Block[] = [];
  let index = 0;
  const nextBlockId = (prefix: string): { id: string; anchorId: string } => {
    index += 1;
    return { id: `b${index}`, anchorId: `${prefix}-${index}` };
  };
  return {
    blocks,
    heading: (parts) => {
      blocks.push({ ...nextBlockId("h"), ...parts });
    },
    paragraph: (parts) => {
      blocks.push({ ...nextBlockId("p"), ...parts });
    },
    table: (parts) => {
      blocks.push({ ...nextBlockId("t"), ...parts });
    },
  };
};

const BODY_ROLE = {
  front: "intro",
  operative: "holding",
  reasoning: "argumentation",
  apparatus: "apparatus",
  closing: "closing",
} as const satisfies Record<Region, ParagraphRole>;

const HEADING_ROLE_BY_LEVEL = {
  1: "section-heading",
  2: "section-heading",
} as const;

export const parseHuBhgyDecision = (
  input: ParseHuBhgyInput,
): ParseHuBhgyOutput => {
  const items = itemsOf(input.document.package.document.content);
  const noteLines: DocLine[] = [];
  for (const note of arrayOrEmpty(input.document.package.footnotes)) {
    if (note.noteType !== undefined && note.noteType !== "normal") {
      continue;
    }
    const label = String(note.id);
    const noteId = `fn-${note.id}`;
    for (const block of note.content) {
      if (block.type === "paragraph") {
        noteLines.push(lineOf(block, { label, noteId }));
      }
    }
  }

  const builder = createBlockBuilder();
  const lineTexts: string[] = [];
  const relatedProceedings: string[] = [];
  const panelLines: string[] = [];
  const statedLabels = new Set<HuBhgyHeaderLabel>();
  /** The header label the lines below a labelled one still belong to. */
  let continuedRole: ParagraphRole | null = null;
  let region: Region = "front";
  let titleEmitted = false;
  let decisionDate: string | undefined;
  /** Lines before the first section heading, where the kind is printed. */
  const titleLines: string[] = [];

  const emitLine = (line: DocLine): void => {
    if (line.text.trim().length === 0) {
      return;
    }
    lineTexts.push(line.text);

    // ── A footnote's own text ──
    //
    // The notes are walked after the body, so every rule below reads a region
    // and a wording this line has nothing to do with: it is the publisher's
    // apparatus wherever the body left off, and it carries the mark it hangs
    // from.
    if (line.note !== undefined) {
      builder.paragraph({
        type: "paragraph",
        role: "apparatus",
        note: { type: "footnote", ...line.note },
        inlines: inlinesOf(line.runs),
        plainText: line.text,
      });
      return;
    }

    const key = headingKey(line.text);

    if (region === "front") {
      titleLines.push(line.text);
    }

    // ── A section heading the publisher prints ──
    const heading = sectionHeadingIn(key);
    if (heading !== null) {
      region = heading.region ?? region;
      builder.heading({
        type: "heading",
        level: heading.level,
        role: HEADING_ROLE_BY_LEVEL[heading.level],
        inlines: inlinesOf(line.runs),
        plainText: line.text,
      });
      return;
    }

    // ── The operative part's own introduction ──
    if (OPERATIVE_INTRODUCTIONS.has(key) && line.text.length <= 40) {
      region = "operative";
      builder.heading({
        type: "heading",
        level: 1,
        role: "section-heading",
        inlines: inlinesOf(line.runs),
        plainText: line.text,
      });
      return;
    }

    if (REPUBLIC_FORMULAE.has(key)) {
      builder.paragraph({
        type: "paragraph",
        role: "front-matter",
        inlines: inlinesOf(line.runs),
        plainText: line.text,
      });
      return;
    }

    // ── The document's own title block ──
    if (!titleEmitted && region === "front" && builder.blocks.length === 0) {
      titleEmitted = true;
      builder.heading({
        type: "heading",
        level: 1,
        role: "decision-title",
        inlines: inlinesOf(line.runs),
        plainText: line.text,
      });
      return;
    }

    // ── Header labels ──
    //
    // A labelled line runs over as many lines as its value needs — one per
    // judge of the bench, one per defendant, the court below on the line after
    // its own label — so the role carries to the unlabelled lines that follow
    // it and ends where the header does.
    if (region === "front") {
      const labelled = huBhgyHeaderLabelIn(line.text);
      const role = labelled?.role ?? continuedRole;
      if (labelled !== null) {
        statedLabels.add(labelled.label);
      }
      if (role !== null) {
        continuedRole = role;
        if (role === "history") {
          relatedProceedings.push(line.text);
        }
        if (role === "panel") {
          panelLines.push(labelled === null ? line.text : labelled.value);
        }
        builder.paragraph({
          type: "paragraph",
          role,
          inlines: inlinesOf(line.runs),
          plainText: line.text,
        });
        return;
      }
    }

    // ── The closing formula and what follows it ──
    if (CLOSING_LINE.test(line.text)) {
      decisionDate ??= huDecisionDateFrom(line.text);
      region = "closing";
      builder.paragraph({
        type: "paragraph",
        role: "closing",
        inlines: inlinesOf(line.runs),
        plainText: line.text,
      });
      return;
    }
    if (key.startsWith(KIADMANY)) {
      region = "closing";
      builder.paragraph({
        type: "paragraph",
        role: "apparatus",
        inlines: inlinesOf(line.runs),
        plainText: line.text,
      });
      return;
    }
    if (region === "closing") {
      builder.paragraph({
        type: "paragraph",
        role: "signature",
        inlines: inlinesOf(line.runs),
        plainText: line.text,
      });
      return;
    }

    // ── Body text ──
    const numbered = COURT_PARAGRAPH_NUMBER.exec(line.text);
    const inlines = inlinesOf(line.runs);
    const number = numbered?.groups?.["number"];
    const role: ParagraphRole = BODY_ROLE[region];
    if (numbered === null || number === undefined) {
      builder.paragraph({
        type: "paragraph",
        role,
        inlines,
        plainText: line.text,
      });
      return;
    }
    // The bracketed number is the citable paragraph number, so it is kept as
    // structure: a citation names `[31]`, and a prefix inside the text would
    // make every search for the paragraph's words find the number too.
    const rest = stripInlinePrefix(inlines, numbered[0].length);
    builder.paragraph({
      type: "paragraph",
      role,
      number: Number(number),
      inlines: rest,
      plainText: inlinesToPlainText(rest),
    });
  };

  for (const item of items) {
    if (item.type === "line") {
      emitLine(item.line);
      continue;
    }
    const rows: TableCell[][] = item.table.rows.map((row) =>
      row.map((cell) => ({
        inlines: inlinesOf(cell.runs),
        plainText: cell.text,
      })),
    );
    const plainText = item.table.rows
      .map((row) => row.map(({ text }) => text).join("\t"))
      .join("\n");
    if (plainText.trim().length === 0) {
      continue;
    }
    lineTexts.push(plainText);
    builder.table({ type: "table", rows, plainText });
  }

  for (const line of noteLines) {
    emitLine(line);
  }

  const { blocks } = builder;
  const fulltext = blocks
    .map(({ plainText }) => plainText.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");

  validateAndLog(
    {
      parser: HU_BHGY_PARSER,
      caseNumber: input.listedCaseNumber,
      language: "hu",
      url: input.sourceUrl,
    },
    buildValidationHtml(lineTexts),
    blocks,
  );

  const documentDocket = huDocketFrom(lineTexts);
  const ast: DocumentAst = {
    version: 1,
    source: {
      system: HU_BHGY_SOURCE_SYSTEM,
      documentId: input.documentId,
      webUrl: input.sourceUrl,
      printUrl: input.documentUrl,
    },
    metadata: {
      caseNumber: input.listedCaseNumber,
      // Hungary issues no ECLI.
      ecli: null,
      court: input.court,
      decisionDate: decisionDate ?? null,
      decisionType: huDecisionTypeFrom(titleLines) ?? null,
      keywords: [],
      statutes: [...input.statutes],
    },
    blocks,
  };

  return {
    documentAst: ast,
    fulltext,
    sections: sectionsFromAst(blocks),
    decisionDate,
    decisionType: huDecisionTypeFrom(titleLines),
    documentDocket,
    relatedProceedings,
    judges: huPanelJudgesFrom(panelLines),
    headerLabels: [...statedLabels],
    readerWarnings: arrayOrEmpty(input.document.warnings),
  };
};
