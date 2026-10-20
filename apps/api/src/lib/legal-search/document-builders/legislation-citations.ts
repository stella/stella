/**
 * References to legislation in guidance text, read as `citation` inlines.
 *
 * Two sources state a reference: a publisher link (EUR-Lex, an ELI, the
 * Czech Collection of Laws) and the printed designation itself
 * ("Regulation (EU) 2016/679", "zákon č. 110/2019 Sb."). Only a link can
 * name the version the author applied, so `appliedVersion` comes from links
 * alone; a printed number is the act, never a version of it.
 *
 * Designation conventions differ by era and series, and a parse that gets the
 * order wrong names a different act:
 * - EU regulations before 2015 print `No number/year` ("No 1215/2012");
 *   later ones, directives and decisions print `year/number`
 *   ("2016/679", "95/46/EC"), with a two-digit year before 1999.
 * - Czech acts print `number/year Sb.` whatever their form.
 */

import { panic, Result } from "better-result";

import { plainTextOf } from "@stll/legal-ast/document-ast";
import type {
  Inline,
  InlineLegislationTarget,
  LegislationSeries,
} from "@stll/legal-ast/inline";

const SERIES_BY_EU_FORM = {
  regulation: "eu-regulation",
  directive: "eu-directive",
  decision: "eu-decision",
} as const satisfies Record<string, LegislationSeries>;

const SERIES_BY_CELEX_TYPE = {
  R: "eu-regulation",
  L: "eu-directive",
  D: "eu-decision",
} as const satisfies Record<string, LegislationSeries>;

const SERIES_BY_ELI_TYPE = {
  reg: "eu-regulation",
  dir: "eu-directive",
  dec: "eu-decision",
} as const satisfies Record<string, LegislationSeries>;

const EARLIEST_YEAR = 1950;
const LATEST_YEAR = 2099;

/** A two-digit EU year: `95/46/EC` is 1995, `02/58` would be 2002. */
const TWO_DIGIT_CENTURY_PIVOT = 50;

const fullYear = (printed: string): number | null => {
  const value = Number(printed);
  if (printed.length !== 2 && printed.length !== 4) {
    return null;
  }
  const century = value >= TWO_DIGIT_CENTURY_PIVOT ? 1900 : 2000;
  const year = printed.length === 2 ? century + value : value;
  return year >= EARLIEST_YEAR && year <= LATEST_YEAR ? year : null;
};

const targetOf = (
  series: LegislationSeries,
  year: number | null,
  number: number,
  appliedOn?: string,
): InlineLegislationTarget | null =>
  year === null || !Number.isSafeInteger(number) || number < 1
    ? null
    : {
        status: "legislation",
        series,
        year,
        number,
        ...(appliedOn === undefined
          ? {}
          : { appliedVersion: { date: appliedOn } }),
      };

const isSeriesKey = <TMap extends Record<string, LegislationSeries>>(
  map: TMap,
  key: string,
): key is Extract<keyof TMap, string> => Object.hasOwn(map, key);

const CELEX =
  /CELEX(?::|%3A)([03])(\d{4})([RLD])(\d{4})(?:-(\d{4})(\d{2})(\d{2}))?/iu;
const EU_ELI =
  /^\/eli\/(reg|dir|dec)(?:_impl|_del)?\/(\d{4})\/(\d{1,4})(?:\/(\d{4}-\d{2}-\d{2}))?(?:\/|$)/u;
const CZ_SB =
  /^\/(?:eli\/cz\/)?sb\/(\d{4})\/(\d{1,4})(?:\/(\d{4}-\d{2}-\d{2}))?(?:\/|$)/u;
const ZAKONY_PRO_LIDI = /^\/cs\/(\d{4})-(\d{1,4})(?:\/|$)/u;

const EUR_LEX_HOST = "eur-lex.europa.eu";
const EU_ELI_HOST = "data.europa.eu";
const E_SBIRKA_HOST = "www.e-sbirka.cz";
const ZAKONY_PRO_LIDI_HOST = "www.zakonyprolidi.cz";

/**
 * The act an absolute publisher link names, or `null` when the link names
 * none this reader knows. Hosts are matched exactly: a look-alike host must
 * not mint a legislation reference.
 */
export const legislationTargetOfHref = (
  href: string,
): InlineLegislationTarget | null => {
  if (!URL.canParse(href)) {
    return null;
  }
  const url = new URL(href);
  const host = url.hostname.toLowerCase();
  if (host === EUR_LEX_HOST) {
    const query = url.search + url.pathname;
    const decoded = Result.try(() => decodeURIComponent(query));
    const celex = CELEX.exec(decoded.status === "ok" ? decoded.value : query);
    if (celex !== null) {
      const [, sector, year, type, number, vy, vm, vd] = celex;
      if (
        sector === undefined ||
        type === undefined ||
        !isSeriesKey(SERIES_BY_CELEX_TYPE, type)
      ) {
        return null;
      }
      const applied =
        sector === "0" &&
        vy !== undefined &&
        vm !== undefined &&
        vd !== undefined
          ? `${vy}-${vm}-${vd}`
          : undefined;
      return targetOf(
        SERIES_BY_CELEX_TYPE[type],
        fullYear(year ?? ""),
        Number(number),
        applied,
      );
    }
  }
  if (host === EU_ELI_HOST || host === EUR_LEX_HOST) {
    const eli = EU_ELI.exec(url.pathname);
    const type = eli?.at(1);
    if (
      eli !== null &&
      type !== undefined &&
      isSeriesKey(SERIES_BY_ELI_TYPE, type)
    ) {
      return targetOf(
        SERIES_BY_ELI_TYPE[type],
        fullYear(eli[2] ?? ""),
        Number(eli[3]),
        eli[4],
      );
    }
    return null;
  }
  if (host === E_SBIRKA_HOST) {
    const sb = CZ_SB.exec(url.pathname);
    return sb === null
      ? null
      : targetOf("cz-sb", fullYear(sb[1] ?? ""), Number(sb[2]), sb[3]);
  }
  if (host === ZAKONY_PRO_LIDI_HOST) {
    const act = ZAKONY_PRO_LIDI.exec(url.pathname);
    return act === null
      ? null
      : targetOf("cz-sb", fullYear(act[1] ?? ""), Number(act[2]));
  }
  return null;
};

/**
 * Printed EU designations. `No` marks number-first order; short regulation
 * numbers followed by a four-digit year also omit it. The
 * trailing `(?!\d)` keeps a longer run of digits from being cut into an act.
 */
const EU_DESIGNATION =
  /\b(Regulation|Directive|Decision)\s+(?:\((?:EU|EC|EEC|Euratom|EU, Euratom)\)\s+)?(No\.?\s+)?(\d{1,4})\/(\d{1,4})(?!\d)(?:\/(?:EU|EC|EEC|Euratom|JHA|CFSP)\b)?/gu;

/** `č. 110/2019 Sb.` with the `č.` optional. */
const CZ_DESIGNATION = /(?<![\p{L}\d])(?:č\.\s*)?(\d{1,4})\/(\d{4})\s+Sb\./gu;

type LegislationMatch = {
  start: number;
  end: number;
  target: InlineLegislationTarget;
};

const euMatchTarget = (
  match: RegExpExecArray,
): InlineLegislationTarget | null => {
  const [, form, numberFirst, left, right] = match;
  if (form === undefined || left === undefined || right === undefined) {
    return null;
  }
  const key = form.toLowerCase();
  if (!isSeriesKey(SERIES_BY_EU_FORM, key)) {
    return null;
  }
  const order =
    numberFirst !== undefined ||
    (key === "regulation" && left.length < 4 && right.length === 4)
      ? "number-first"
      : "year-first";
  return order === "number-first"
    ? targetOf(SERIES_BY_EU_FORM[key], fullYear(right), Number(left))
    : targetOf(SERIES_BY_EU_FORM[key], fullYear(left), Number(right));
};

/** Every printed act designation in `text`, in order, never overlapping. */
export const legislationMatchesIn = (text: string): LegislationMatch[] => {
  const matches: LegislationMatch[] = [];
  for (const match of text.matchAll(EU_DESIGNATION)) {
    const target = euMatchTarget(match);
    if (target !== null) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        target,
      });
    }
  }
  for (const match of text.matchAll(CZ_DESIGNATION)) {
    const target = targetOf(
      "cz-sb",
      fullYear(match[2] ?? ""),
      Number(match[1]),
    );
    if (target !== null) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        target,
      });
    }
  }
  matches.sort((a, b) => a.start - b.start);
  const disjoint: LegislationMatch[] = [];
  for (const match of matches) {
    const previous = disjoint.at(-1);
    if (previous === undefined || match.start >= previous.end) {
      disjoint.push(match);
    }
  }
  return disjoint;
};

/** Append text, merging into a text node before it as the inline model expects. */
const appendText = (target: Inline[], text: string): void => {
  if (text === "") {
    return;
  }
  const last = target.at(-1);
  if (last?.type === "text" && last.anonymized === undefined) {
    target[target.length - 1] = { type: "text", text: last.text + text };
    return;
  }
  target.push({ type: "text", text });
};

/**
 * `text` split around its designations. `before` is the run's character
 * just ahead of `text`: whether a designation starts here depends on it, and
 * reading it keeps the result the same whether or not an earlier pass already
 * split the run at this point.
 */
const splitText = (text: string, before: string, target: Inline[]): void => {
  let cursor = 0;
  for (const match of legislationMatchesIn(before + text)) {
    const start = match.start - before.length;
    const end = match.end - before.length;
    if (start < 0) {
      continue;
    }
    appendText(target, text.slice(cursor, start));
    const cite = text.slice(start, end);
    target.push({
      type: "citation",
      cite,
      children: [{ type: "text", text: cite }],
      target: match.target,
    });
    cursor = end;
  }
  appendText(target, text.slice(cursor));
};

/**
 * `inlines` with every legislation reference read as a citation: a link
 * naming an act becomes a citation keeping its `href`, and a printed
 * designation in plain text becomes one around exactly its characters.
 *
 * The character axis is unchanged: a citation's text is its children, so
 * `plainTextOf` reads the same before and after. Existing citations and
 * links to anything else are left as they are, and anonymized text is never
 * read for references.
 */
export const withLegislationCitations = (
  inlines: readonly Inline[],
): Inline[] => {
  const out: Inline[] = [];
  let before = "";
  for (const inline of inlines) {
    const pushedFrom = out.length;
    switch (inline.type) {
      case "text": {
        if (inline.anonymized === true) {
          out.push(inline);
        } else {
          splitText(inline.text, before, out);
        }
        break;
      }
      case "link": {
        const target = legislationTargetOfHref(inline.href);
        const cite = plainTextOf(inline.children).trim();
        if (target === null || cite === "") {
          out.push(inline);
          break;
        }
        out.push({
          type: "citation",
          cite,
          href: inline.href,
          children: inline.children,
          target,
        });
        break;
      }
      case "bold":
      case "italic":
      case "underline":
      case "superscript":
      case "subscript": {
        out.push({
          type: inline.type,
          children: withLegislationCitations(inline.children),
        });
        break;
      }
      case "citation":
      case "line-break":
      case "page-anchor": {
        out.push(inline);
        break;
      }
      default: {
        inline satisfies never;
        panic(`Unhandled inline: ${String(inline)}`);
      }
    }
    // Text may have merged into the node before, so read the run's last node.
    const last = out.at(-1);
    if (out.length > pushedFrom || last?.type === "text") {
      before =
        last === undefined ? before : plainTextOf([last]).slice(-2) || before;
    }
  }
  return out;
};
