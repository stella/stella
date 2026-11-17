/**
 * Citations to the two codified bodies of US federal law: the United States
 * Code (`42 U.S.C. § 1983(a)`) and the Code of Federal Regulations
 * (`12 C.F.R. § 1026.18(c)(1)`).
 *
 * A US code citation names its work outright: the title, the code and the
 * section are the identity of the section, and the section is the unit the
 * corpus holds as a work. What follows the section is the paragraph path
 * inside it (`(a)(1)(A)`), printed with the publisher's own labels and kept
 * exactly as printed: the label of a level says nothing reliable about its
 * depth (`(i)` is a clause in one code and a letter in another), so the path
 * is never re-derived from it.
 *
 * The reader is anchored on the code token (`U.S.C.`, `C.F.R.`, their spaced,
 * undotted, annotated and spelled-out forms, `Treas. Reg.` and `FAR`), reads
 * the title before it and the sections after it, and accepts nothing it
 * cannot place: a title outside the code's range, a code with no section, a
 * part (`12 C.F.R. pt. 1026`) or an appendix (`50 U.S.C. app.`) is not a
 * section and yields nothing. A bare `§ 1983` names no title and is left to a
 * reader that knows what the decision cited before.
 *
 * The citation forms are the ones US courts use, checked against the forms
 * Free Law Project's reporters-db and eyecite record (BSD 2-Clause; see
 * `us-code-citations.LICENSE`) and against real opinion text.
 */

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { US_REPORTER_SPELLING_SOURCE } from "@stll/api-contract/us-reporter-citation";
import type { ProvisionReference } from "@stll/legal-ast/provision-reference";
import { US_CODE_ANCHORS } from "@stll/legal-ast/statute-anchor-scheme";

/** The two codes, keyed as the corpus addresses them. */
export const US_CODES = {
  usc: { canonical: "U.S.C.", maxTitle: 54 },
  cfr: { canonical: "C.F.R.", maxTitle: 50 },
} as const;

export type UsCode = keyof typeof US_CODES;

/** One section of one title of one code: a work in the corpus. */
export type UsCodeWork = {
  code: UsCode;
  title: number;
  /** As the code numbers it, dashes normalised: `1983`, `2000e-2`, `1.401(k)-1`. */
  section: string;
};

/** One cited section, with the paragraph path the citation names in it. */
export type LocatedUsCodeCitation = {
  work: UsCodeWork;
  /** Paragraph labels outermost first, as printed: `["a", "1", "A"]`. */
  path: readonly string[];
  /** The citation runs on from here (`et seq.`). */
  openEnded: boolean;
  start: number;
  end: number;
};

/** Hyphens and dashes a section number is typeset with. */
const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2212]/gu;

/** A section designator with every dash a plain hyphen. */
const canonicalSection = (code: UsCode, raw: string): string => {
  const dashed = raw.replaceAll(DASHES, () => "-");
  // The Code numbers its sections in lower case (`2000e`, `1395w-4`); the
  // CFR keeps capitals (`1.409A-1`, a temporary rule's `-4T`).
  return code === "usc" ? dashed.toLowerCase() : dashed;
};

const USC_SECTION = /^[1-9]\d{0,4}[a-z]{0,4}(?:-\d{1,4}[a-z]{0,3}){0,2}$/u;
const CFR_SECTION =
  /^(?:0|[1-9]\d{0,3})[a-zA-Z]?\.\d{1,5}[a-zA-Z0-9]*(?:(?:\((?:[a-zA-Z]{1,3}|\d{1,2})\))*-\d{1,4}[a-zA-Z]?)?$/u;
const SECTION_PATTERNS = {
  usc: USC_SECTION,
  cfr: CFR_SECTION,
} as const satisfies Record<UsCode, RegExp>;

const PATH_LABEL = /^(?:[a-zA-Z]{1,5}|\d{1,3}[a-zA-Z]?)$/u;

/** Whether a work names a real title and a well-formed section of its code. */
export const isUsCodeWork = (work: UsCodeWork): boolean =>
  Number.isSafeInteger(work.title) &&
  work.title >= 1 &&
  work.title <= US_CODES[work.code].maxTitle &&
  SECTION_PATTERNS[work.code].test(work.section);

/** `42 U.S.C. 1983`, `12 C.F.R. 1026.18`: the work's canonical identifier. */
export const usCodeWorkIdentifier = (work: UsCodeWork): string =>
  `${String(work.title)} ${US_CODES[work.code].canonical} ${work.section}`;

const WORK_IDENTIFIER =
  /^(?<title>[1-9]\d?) (?<code>U\.S\.C\.|C\.F\.R\.) (?<section>\S+)$/u;

/** A title or section number the reader matched, as a number; null for any other text. */
const wholeNumber = (digits: string | undefined): number | null =>
  parseIntegerToken(digits, { sign: "unsigned" }).unwrapOr(null);

/** The work a canonical identifier names, or null for any other text. */
export const parseUsCodeWorkIdentifier = (raw: string): UsCodeWork | null => {
  const groups = WORK_IDENTIFIER.exec(raw)?.groups;
  const section = groups?.["section"];
  const title = wholeNumber(groups?.["title"]);
  if (groups === undefined || section === undefined || title === null) {
    return null;
  }
  const work: UsCodeWork = {
    code: groups["code"] === "U.S.C." ? "usc" : "cfr",
    title,
    section,
  };
  return isUsCodeWork(work) && usCodeWorkIdentifier(work) === raw ? work : null;
};

/**
 * The work's ELI as the corpus stores it: the Code section's own USLM
 * identifier, and the eCFR's reader address of the regulation's current
 * text.
 */
export const usCodeWorkEli = (work: UsCodeWork): string =>
  work.code === "usc"
    ? `/us/usc/t${String(work.title)}/s${work.section}`
    : `https://www.ecfr.gov/current/title-${String(work.title)}/section-${encodeURIComponent(work.section)}`;

// --- Reading --------------------------------------------------------------

/** Whitespace between the parts of a citation, the no-break kinds included. */
const GAP = String.raw`[\s\u00a0\u202f]`;
const DASH = String.raw`[\-\u2010\u2011\u2013]`;

const USC_TOKEN = String.raw`(?:U\.${GAP}{0,2}S\.${GAP}{0,2}C\.(?:${GAP}?[ASU]\.)?(?![\p{L}])|(?<![\p{L}\p{N}])USC[AS]?(?![\p{L}\p{N}])|U\.${GAP}?S\.${GAP}{1,2}Code(?:${GAP}{1,2}(?:Annotated|Service))?|United${GAP}{1,2}States${GAP}{1,2}Code(?:${GAP}{1,2}(?:Annotated|Service))?)`;
const CFR_TOKEN = String.raw`(?:C\.${GAP}{0,2}F\.${GAP}{0,2}R\.(?![\p{L}])|(?<![\p{L}\p{N}])CFR(?![\p{L}\p{N}])|Code${GAP}{1,2}of${GAP}{1,2}Federal${GAP}{1,2}Regulations)`;
const TREASURY_TOKEN = String.raw`(?:Treas(?:ury)?\.?${GAP}{1,2}Regs?\.|Treasury${GAP}{1,2}Regulations?)`;
const FAR_TOKEN = String.raw`(?<![\p{L}\p{N}])FAR(?![\p{L}\p{N}])`;

/** The code tokens; Treasury and FAR rules name their title themselves. */
const CODE_TOKEN = new RegExp(
  String.raw`(?<usc>${USC_TOKEN})|(?<cfr>${CFR_TOKEN})|(?<treasury>${TREASURY_TOKEN})|(?<far>${FAR_TOKEN})`,
  "gu",
);

/** `42 `, `Title 42 `, `21, `: the title immediately before a code token. */
const TITLE_BEFORE = new RegExp(
  String.raw`(?<![\p{L}\p{N}.§$/\-])(?:(?:[Tt]itle|TITLE)${GAP}{1,2})?(?<title>[1-9]\d?)${GAP}{0,2},?${GAP}{1,16}$`,
  "u",
);

const PARAGRAPH_BREAK = /\n[^\S\n]*\n/u;

const sticky = (source: string): RegExp => new RegExp(source, "uy");

/**
 * What may stand between a code and its section without breaking the
 * citation: a star page an opinion's pagination puts there
 * (`28 U.S.C. *5§ 1782`), and the alias a Treasury rule is cited with
 * beside its title (`26 C.F.R. (Treas. Reg.) § 1.170A-14`).
 */
const INTERPOSED = String.raw`(?:${GAP}{0,2}\*\d{1,5}|${GAP}{0,2}\(${TREASURY_TOKEN}\))?`;

/** `§`, `§§` (spaced, or bracketed by an alteration), the section sign after the word. */
const SECTION_SIGN = String.raw`(?:§${GAP}?§|§|\[§§?\])`;

/**
 * `§`, `§§`, `sec.`, `Section`, `secs.`, the bare `S.` older indexes print,
 * and a word with a sign after it (`Section § 3742`).
 */
const MARKER = sticky(
  String.raw`${INTERPOSED},?${GAP}{0,16}(?:${SECTION_SIGN}|[Ss]ec(?:tion)?s?\.?(?![\p{L}])(?:${GAP}{0,2}${SECTION_SIGN})?|S\.)${GAP}{0,16}`,
);
/** No marker at all: `28 U.S.C. 1331`, `12 CFR 1026.18`. */
const MARKER_GAP = sticky(String.raw`${INTERPOSED},?${GAP}{1,3}`);
/** A code that carries no section here: its appendix, a part, a chapter. */
const NOT_A_SECTION = sticky(
  String.raw`,?${GAP}{0,3}(?:[Aa]pp\.|[Pp](?:ar)?ts?\.?(?![\p{L}])|Subpart|[Cc]h\.|[Cc]hapter)`,
);

/** The base of a section number: `2000e`, `1026.18`, `1.401`. */
const DESIGNATOR_BASES = {
  usc: sticky(String.raw`[1-9]\d{0,4}[a-zA-Z]{0,4}`),
  cfr: sticky(String.raw`\d{1,4}[a-zA-Z]?\.\d{1,5}[a-zA-Z0-9]*`),
} as const satisfies Record<UsCode, RegExp>;
/** `-2` in `2000e-2`, `-1` in `78j-1`. */
const USC_CONTINUATION = sticky(
  String.raw`${DASH}(?<digits>\d{1,4})[a-zA-Z]{0,3}`,
);
/** `-5` in `52.212-5`, `(k)-1` in `1.401(k)-1`, `-4T` in a temporary rule. */
const CFR_CONTINUATION = sticky(
  String.raw`(?:\((?:[a-zA-Z]{1,3}|\d{1,2})\))*${DASH}\d{1,4}[a-zA-Z]?(?![\p{N}]|\.\d)`,
);
/** A designator does not stop inside a longer number. */
const DESIGNATOR_END = sticky(String.raw`(?![\p{N}]|\.\d)`);

const PATH = sticky(String.raw`(?:\((?:[a-zA-Z]{1,5}|\d{1,3}[a-zA-Z]?)\))+`);
const RANGE = sticky(
  String.raw`${GAP}{0,2}(?:[\-\u2010\u2011\u2013\u2014]|through|thru|to)${GAP}{0,2}(?:§§?${GAP}{0,2})?`,
);
const LIST = sticky(
  String.raw`${GAP}{0,2}[,;]?${GAP}{0,2}(?:(?:and|or|&)${GAP}{1,2})?(?:§§?${GAP}{0,2})?`,
);
const PATH_LIST = sticky(
  String.raw`${GAP}{0,2}(?:,${GAP}{0,2}(?:(?:and|or)${GAP}{1,2})?|(?:and|or|&)${GAP}{1,2})`,
);
const ET_SEQ = sticky(String.raw`,?${GAP}{0,2}et\.?${GAP}{1,2}seq\.?`);
/**
 * After a listed number: the start of another citation. `42 U.S.C. § 1983,
 * 28 U.S.C. § 1331` lists two titles, and `§ 1291, 1 F.3d 2` ends at the
 * reporter.
 */
const NEXT_CITATION = sticky(
  String.raw`${GAP}{0,3},?${GAP}{0,3}(?:(?:[Tt]itle${GAP}{1,2})?${USC_TOKEN}|${CFR_TOKEN}|${US_REPORTER_SPELLING_SOURCE})`,
);
/** A listed number followed by a word that is not a connector is prose. */
const PROSE_AFTER = sticky(
  String.raw`${GAP}{1,3}(?!(?:and|or|et|through|thru|to)(?![\p{L}]))\p{Ll}`,
);

const matchAt = (
  pattern: RegExp,
  text: string,
  index: number,
): RegExpExecArray | null => {
  pattern.lastIndex = index;
  return pattern.exec(text);
};

const endOf = (match: RegExpExecArray): number => match.index + match[0].length;

const leadDigits = (section: string): number =>
  /^\d+/u.exec(section)?.[0].length ?? 0;

/** `(a)(1)(A)` as its labels. */
const pathLabels = (printed: string): string[] =>
  [...printed.matchAll(/\(([^()]+)\)/gu)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );

/**
 * A section number at `index`, and where it ends.
 *
 * A dash continues the number only where the Code itself numbers that way:
 * an inserted section's number is shorter than the one it follows
 * (`2000e-2`, `78j-1`, `300gg-11`, typeset with an en dash too), so a dash
 * before an equally long number opens a range (`1981-1983`,
 * `2000e-2000e-17`). A one-digit section with letters has no shorter number
 * to insert, so its one-digit tail continues it (`1a-2`). A CFR number continues only with the short tail a
 * Treasury, FAR or temporary rule carries, never with another section
 * (`1026.18-1026.20`).
 */
const readDesignator = (
  code: UsCode,
  text: string,
  index: number,
): { value: string; end: number } | null => {
  const base = matchAt(DESIGNATOR_BASES[code], text, index);
  if (base === null) {
    return null;
  }
  let value = base[0];
  let end = endOf(base);
  if (code === "usc") {
    const lead = leadDigits(value);
    for (let parts = 0; parts < 2; parts += 1) {
      const continuation = matchAt(USC_CONTINUATION, text, end);
      const digits = continuation?.groups?.["digits"];
      const inserted =
        digits !== undefined &&
        (digits.length < lead ||
          (lead === 1 && digits.length === 1 && /[a-zA-Z]$/u.test(value)));
      if (continuation === null || !inserted) {
        break;
      }
      value += continuation[0];
      end = endOf(continuation);
    }
  } else {
    const continuation = matchAt(CFR_CONTINUATION, text, end);
    if (continuation !== null) {
      value += continuation[0];
      end = endOf(continuation);
    }
  }
  return matchAt(DESIGNATOR_END, text, end) === null ? null : { value, end };
};

type Shape = "digit" | "lower" | "upper" | "roman-lower" | "roman-upper";

const ROMAN = /^x{0,3}(?:ix|iv|v?i{0,3})$/u;

/** What a label could be, by its printed form alone. */
const shapesOf = (label: string): readonly Shape[] => {
  if (/^\d/u.test(label)) {
    return ["digit"];
  }
  const lower = label.toLowerCase();
  const isLower = label === lower;
  const shapes: Shape[] = [];
  // `(a)`, and the doubled `(aa)` an item is labelled with.
  if (/^([a-z])\1*$/iu.test(label)) {
    shapes.push(isLower ? "lower" : "upper");
  }
  if (lower !== "" && ROMAN.test(lower)) {
    shapes.push(isLower ? "roman-lower" : "roman-upper");
  }
  return shapes;
};

/**
 * Where a coordinated label (`(d)` in `(a)(2) and (d)`) continues the path
 * before it: at the deepest level whose label could be of the same kind,
 * keeping the levels above it. Null where no level could be, so a label the
 * path cannot place is left as text rather than guessed onto it.
 */
const coordinatedPath = (
  previous: readonly string[],
  next: readonly string[],
): string[] | null => {
  const [head] = next;
  if (head === undefined) {
    return null;
  }
  const headShapes = shapesOf(head);
  for (let depth = previous.length - 1; depth >= 0; depth -= 1) {
    const label = previous[depth];
    if (
      label !== undefined &&
      shapesOf(label).some((shape) => headShapes.includes(shape))
    ) {
      return [...previous.slice(0, depth), ...next];
    }
  }
  return null;
};

type Element = {
  section: string;
  path: string[];
  openEnded: boolean;
  start: number;
  end: number;
};

/** A section number with its path, read at `index`. */
const readElement = (
  code: UsCode,
  text: string,
  index: number,
): Element | null => {
  const designator = readDesignator(code, text, index);
  if (designator === null) {
    return null;
  }
  const path = matchAt(PATH, text, designator.end);
  return {
    section: canonicalSection(code, designator.value),
    path: path === null ? [] : pathLabels(path[0]),
    openEnded: false,
    start: index,
    end: path === null ? designator.end : endOf(path),
  };
};

/**
 * Whether a range's far end is a section of the same kind as its near end:
 * `1026.18-1026.20` ends on a CFR section, `2000e-2000e-17` on a number at
 * least as long as the one it started from.
 */
const closesRange = (
  code: UsCode,
  previous: Element,
  next: Element,
): boolean =>
  code === "cfr"
    ? next.section.includes(".")
    : leadDigits(next.section) >= leadDigits(previous.section);

const isSection = (code: UsCode, section: string): boolean =>
  SECTION_PATTERNS[code].test(section);

/** The element a coordinated path (`and (d)`) after `last` names, if any. */
const readCoordinated = (text: string, last: Element): Element | null => {
  const joined = matchAt(PATH_LIST, text, last.end);
  const coordinated =
    joined === null ? null : matchAt(PATH, text, endOf(joined));
  if (coordinated === null) {
    return null;
  }
  const path = coordinatedPath(last.path, pathLabels(coordinated[0]));
  return path === null
    ? null
    : {
        section: last.section,
        path,
        openEnded: false,
        start: coordinated.index,
        end: endOf(coordinated),
      };
};

/**
 * The far end of a range after `last`, if one follows: another section
 * (`1981-1983`), or a path inside the same one, read against the path it
 * continues (`1229a(c)(6)-(7)` ends on `(c)(7)`).
 */
const readRangeEnd = (
  code: UsCode,
  text: string,
  last: Element,
): Element | null => {
  const range = matchAt(RANGE, text, last.end);
  if (range === null) {
    return null;
  }
  const subdivision =
    last.path.length === 0 ? null : matchAt(PATH, text, endOf(range));
  if (subdivision !== null) {
    const path = coordinatedPath(last.path, pathLabels(subdivision[0]));
    return path === null
      ? null
      : {
          section: last.section,
          path,
          openEnded: false,
          start: subdivision.index,
          end: endOf(subdivision),
        };
  }
  const end = readElement(code, text, endOf(range));
  return end !== null && closesRange(code, last, end) ? end : null;
};

/**
 * A further listed section after `last`, if the list goes on. Prose right
 * after a number usually means it counts something (`§ 1983 and 12 days`),
 * but a citation that announced several sections (`§§`, `Sections`) keeps
 * a number as long as the one before it (`§§ 1331 and 1343 confer`).
 */
const readListed = (
  code: UsCode,
  text: string,
  last: Element,
  plural: boolean,
): Element | null => {
  const list = matchAt(LIST, text, last.end);
  if (list === null || list[0].trim() === "") {
    return null;
  }
  const next = readElement(code, text, endOf(list));
  if (next === null || matchAt(NEXT_CITATION, text, next.end) !== null) {
    return null;
  }
  const listed = plural && leadDigits(next.section) >= leadDigits(last.section);
  return matchAt(PROSE_AFTER, text, next.end) === null || listed ? next : null;
};

/** A marker that announces more than one section: `§§`, `Sections`, `secs.`. */
const PLURAL_MARKER = new RegExp(
  String.raw`§${GAP}{0,2}§|[Ss]ec(?:tion)?s(?![\p{L}])`,
  "u",
);

/** The sections a code token is followed by, read from `index`. */
const readSections = (code: UsCode, text: string, index: number): Element[] => {
  if (matchAt(NOT_A_SECTION, text, index) !== null) {
    return [];
  }
  const marker =
    matchAt(MARKER, text, index) ?? matchAt(MARKER_GAP, text, index);
  const first = marker === null ? null : readElement(code, text, endOf(marker));
  if (first === null) {
    return [];
  }
  const plural = marker !== null && PLURAL_MARKER.test(marker[0]);
  const elements: Element[] = [first];
  let last = first;
  for (;;) {
    const seq = matchAt(ET_SEQ, text, last.end);
    if (seq !== null) {
      last.openEnded = true;
      last.end = endOf(seq);
      break;
    }
    const next =
      readCoordinated(text, last) ??
      readRangeEnd(code, text, last) ??
      readListed(code, text, last, plural);
    if (next === null) {
      break;
    }
    elements.push(next);
    last = next;
  }
  return elements.filter((element) => isSection(code, element.section));
};

type CodeHit = { code: UsCode; title: number; start: number; end: number };

/** The code a token names and the title it states or implies. */
const codeHitAt = (text: string, match: RegExpExecArray): CodeHit | null => {
  const groups = match.groups ?? {};
  const end = endOf(match);
  if (groups["treasury"] !== undefined) {
    return { code: "cfr", title: 26, start: match.index, end };
  }
  if (groups["far"] !== undefined) {
    return { code: "cfr", title: 48, start: match.index, end };
  }
  const code: UsCode = groups["usc"] === undefined ? "cfr" : "usc";
  const before = TITLE_BEFORE.exec(
    text.slice(Math.max(0, match.index - 40), match.index),
  );
  const title = wholeNumber(before?.groups?.["title"]);
  if (
    before === null ||
    title === null ||
    title > US_CODES[code].maxTitle ||
    // A number across a paragraph break is a page number or a footnote
    // mark, not the title (`Court 3\n\n C.F.R. § 1614.106`).
    PARAGRAPH_BREAK.test(before[0])
  ) {
    return null;
  }
  return { code, title, start: match.index - before[0].length, end };
};

/** `section 1983 of title 42, United States Code`: the statutes' own form. */
const PHRASE = new RegExp(
  String.raw`(?<![\p{L}])[Ss]ection${GAP}{1,16}(?<section>[1-9]\d{0,4}[a-z]{0,4}(?:${DASH}\d{1,3}[a-z]{0,3}){0,2})(?<path>(?:\((?:[a-zA-Z]{1,5}|\d{1,3}[a-zA-Z]?)\))*)${GAP}{1,16}of${GAP}{1,16}(?:(?:[Tt]itle|TITLE)${GAP}{1,16})?(?<title>[1-9]\d?)(?:,|${GAP}{1,16}of${GAP}{1,2}the)?${GAP}{1,16}(?:United${GAP}{1,2}States${GAP}{1,2}Code|U\.${GAP}?S\.${GAP}?C\.)`,
  "gu",
);

const located = (
  code: UsCode,
  title: number,
  element: Element,
): LocatedUsCodeCitation | null => {
  const work: UsCodeWork = { code, title, section: element.section };
  return isUsCodeWork(work)
    ? {
        work,
        path: element.path,
        openEnded: element.openEnded,
        start: element.start,
        end: element.end,
      }
    : null;
};

/**
 * Every US Code and CFR section the text cites, in reading order. The first
 * section of a citation spans the whole citation from its title; each
 * further listed section spans its own number.
 */
export const locateUsCodeCitations = (
  text: string,
): LocatedUsCodeCitation[] => {
  const citations: LocatedUsCodeCitation[] = [];
  for (const match of text.matchAll(CODE_TOKEN)) {
    const hit = codeHitAt(text, match);
    if (hit === null) {
      continue;
    }
    const [first, ...rest] = readSections(hit.code, text, hit.end);
    if (first === undefined) {
      continue;
    }
    for (const element of [{ ...first, start: hit.start }, ...rest]) {
      const citation = located(hit.code, hit.title, element);
      if (citation !== null) {
        citations.push(citation);
      }
    }
  }
  for (const match of text.matchAll(PHRASE)) {
    const section = match.groups?.["section"];
    const title = wholeNumber(match.groups?.["title"]);
    if (section === undefined || title === null) {
      continue;
    }
    const citation = located("usc", title, {
      section: canonicalSection("usc", section),
      path: pathLabels(match.groups?.["path"] ?? ""),
      openEnded: false,
      start: match.index,
      end: endOf(match),
    });
    if (citation !== null) {
      citations.push(citation);
    }
  }
  return citations.toSorted((left, right) => left.start - right.start);
};

// --- Identity -------------------------------------------------------------

/** The section a reference carries: its leading number and the rest. */
const SECTION_SPLIT = /^(?<number>0|[1-9]\d*)(?<suffix>\D.*)?$/u;

/**
 * A located citation as the jurisdiction-neutral reference: the section's
 * leading number and the rest of its designator (`1026` + `.18`), and the
 * paragraph path as printed in `subsection` (`(c)(1)`). US citations name
 * no letters, points or sentences of their own.
 */
export const usCodeReference = (
  citation: Pick<LocatedUsCodeCitation, "work" | "path" | "openEnded">,
): ProvisionReference | null => {
  const parts = SECTION_SPLIT.exec(citation.work.section)?.groups;
  const number = wholeNumber(parts?.["number"]);
  if (number === null) {
    return null;
  }
  const suffix = parts?.["suffix"] ?? "";
  return {
    unit: "section",
    section: number,
    sectionSuffix: suffix === "" ? null : suffix,
    subsection:
      citation.path.length === 0
        ? null
        : citation.path.map((label) => `(${label})`).join(""),
    letter: null,
    point: null,
    sentence: null,
    openEnded: citation.openEnded,
  };
};

const sectionOf = (reference: ProvisionReference): string =>
  `${String(reference.section)}${reference.sectionSuffix ?? ""}`;

/** The code whose section numbering a section designator follows. */
const codeOfSection = (section: string): UsCode | null => {
  if (CFR_SECTION.test(section)) {
    return "cfr";
  }
  return USC_SECTION.test(section) ? "usc" : null;
};

/**
 * The anchor a reference lands on in the section's statute text:
 * `s1983/a/1/A`. Relative to the section, as every anchor is relative to
 * its work, and cut on `/` into the provisions it sits under.
 */
export const usCodeAnchor = (reference: ProvisionReference): string =>
  [`s${sectionOf(reference)}`, ...pathLabels(reference.subsection ?? "")].join(
    US_CODE_ANCHORS.segmentSeparator,
  );

export const parseUsCodeAnchor = (raw: string): ProvisionReference | null => {
  const [head, ...labels] = raw.split(US_CODE_ANCHORS.segmentSeparator);
  const section = head?.startsWith("s") === true ? head.slice(1) : null;
  const code = section === null ? null : codeOfSection(section);
  if (
    section === null ||
    code === null ||
    !labels.every((label) => PATH_LABEL.test(label))
  ) {
    return null;
  }
  return usCodeReference({
    work: { code, title: 1, section },
    path: labels,
    openEnded: false,
  });
};

/** A reference read as a US citation would print it, or null if it cannot be one. */
export const normalizeUsCodeReference = (
  reference: ProvisionReference,
): ProvisionReference | null => {
  if (
    reference.unit !== "section" ||
    reference.letter !== null ||
    reference.point !== null ||
    reference.sentence !== null
  ) {
    return null;
  }
  const dashed: ProvisionReference = {
    ...reference,
    sectionSuffix:
      reference.sectionSuffix === null
        ? null
        : reference.sectionSuffix.replaceAll(DASHES, () => "-"),
  };
  const subsection = dashed.subsection;
  if (subsection !== null && !/^(?:\([^()]+\))+$/u.test(subsection)) {
    return null;
  }
  const anchored = parseUsCodeAnchor(usCodeAnchor(dashed));
  return anchored === null
    ? null
    : { ...anchored, openEnded: reference.openEnded };
};

const REFERENCE = new RegExp(
  String.raw`^(?:§§?${GAP}*)?(?<section>(?:0(?=\.)|[1-9])[\p{L}\p{N}.()\-\u2010\u2011\u2013]*?)(?<path>(?:\((?:[a-zA-Z]{1,5}|\d{1,3}[a-zA-Z]?)\))*)$`,
  "u",
);

/** `§ 1983(a)(1)`, `1026.18(c)`: a section and path without its work. */
export const parseUsCodeReference = (
  raw: string,
): ProvisionReference | null => {
  const groups = REFERENCE.exec(raw.trim())?.groups;
  const printed = groups?.["section"];
  const dashed =
    printed === undefined ? null : printed.replaceAll(DASHES, () => "-");
  const code = dashed === null ? null : codeOfSection(dashed);
  if (dashed === null || code === null) {
    return null;
  }
  return usCodeReference({
    work: { code, title: 1, section: canonicalSection(code, dashed) },
    path: pathLabels(groups?.["path"] ?? ""),
    openEnded: false,
  });
};

/** `§ 1983(a)(1)`, `§ 1026.18(c) et seq.`: the reference as US courts print it. */
export const formatUsCodeReference = (reference: ProvisionReference): string =>
  `§ ${sectionOf(reference)}${reference.subsection ?? ""}${reference.openEnded ? " et seq." : ""}`;
