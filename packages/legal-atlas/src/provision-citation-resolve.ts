import { panic } from "better-result";

import { foldToAscii, normalizeUnicode } from "@stll/text-normalize";

import {
  type ActTitleSpec,
  ANCHORED_SUBDIVISION_LEVELS,
  formatWorkIdentifier,
  type JurisdictionProfile,
  SECTION_UNITS,
  type SectionUnit,
  type WorkIdentifier,
} from "./provision-citation-profile";
import { provisionCitationProfileFor } from "./provision-citation-profiles";

/**
 * The provision a caller asks about, read from how a lawyer types it:
 * `§ 316 odst. 2 ZP`, `§316/2 zák. práce`, `ust. § 52 písm. g) zákoníku práce`,
 * `čl. 10 Listiny`, `262/2006 Sb. § 316`.
 *
 * The section path is required; every level below it is optional and
 * narrows. Nothing below the deepest level the caller named is implied:
 * `§ 316` asks for the whole section, including every subsection of it.
 */
export type ResolvedProvisionCitation = {
  status: "resolved";
  work: WorkIdentifier;
  workIdentifier: string;
  unit: SectionUnit;
  section: number;
  sectionSuffix: string | null;
  subsection: string | null;
  letter: string | null;
  point: string | null;
  /** The publisher anchor of the deepest level named. */
  anchor: string;
  /** A canonical spelling of what was resolved, for echoing back. */
  citation: string;
};

export type ProvisionCitationResolution =
  | ResolvedProvisionCitation
  | { status: "no_provision" }
  /**
   * The text names several provisions or a range (`§ 316 odst. 2 a 3`,
   * `§ 316–318`, `§§ 2 až 4`, `§ 2 a násl.`): one filter cannot stand for
   * them, so the caller is told rather than given the first.
   */
  | { status: "multiple_provisions" }
  | { status: "no_act" }
  | {
      status: "ambiguous_act";
      candidates: readonly { work: WorkIdentifier; workIdentifier: string }[];
    }
  | { status: "unit_mismatch"; work: WorkIdentifier; workIdentifier: string };

type ResolveOptions = {
  text: string;
  profile: JurisdictionProfile;
  /**
   * The date the citation is read for (ISO). A recodified title names the
   * act in force then; a caller asking about current law passes today.
   */
  citedOn: string;
};

const SPACES = /[\s   ]+/gu;
// A suffix is written on the number (`§ 1a`); `§ 316 a § 317` is two sections.
const SECTION_VALUE = String.raw`(?<number>\d{1,5})(?<suffix>[a-z])?(?![\p{L}\p{N}])`;
/** A lettered item's letter: Czech orders `ch` after `h` as one letter. */
const LETTER = String.raw`(?:ch|[a-z])`;
/** What each level's value looks like; a sentence is read only to be skipped. */
const SUBDIVISION_VALUES = {
  subsection: String.raw`(?<value>\d{1,4}[a-z]?)`,
  letter: String.raw`(?<value>${LETTER})\)?`,
  point: String.raw`(?<value>\d{1,4})`,
  sentence: String.raw`(?<value>\d{1,2}|\p{L}+)`,
} as const;

const normalize = (text: string) =>
  normalizeUnicode(text, "NFC").replace(SPACES, " ").trim();

const foldKey = (text: string) => foldToAscii(text).toLowerCase();

/** A term the profile spells with a trailing period also matches without it. */
const termSource = (text: string) => {
  const escaped = RegExp.escape(text);
  return text.endsWith(".") ? `${escaped.slice(0, -2)}\\.?` : escaped;
};

/**
 * Words that join provisions in a caller's own phrasing beyond the profile's
 * enumeration connectors, which describe court citations: an alternative
 * (`resp.`, `popř.`) still names two provisions one filter cannot stand for.
 */
const CALLER_ALTERNATIVE_CONNECTORS = [
  "resp.",
  "respektive",
  "popř.",
  "popřípadě",
  "event.",
  "eventuálně",
] as const;

const connectorSource = (profile: JurisdictionProfile) =>
  [
    ...profile.enumerationConnectors,
    ...profile.rangeConnectors,
    ...CALLER_ALTERNATIVE_CONNECTORS,
  ]
    .toSorted((left, right) => right.length - left.length)
    .map((word) => RegExp.escape(word))
    .join("|");

const alternation = (texts: readonly string[]) =>
  texts
    .toSorted((left, right) => right.length - left.length)
    .map(termSource)
    .join("|");

type CompiledResolver = {
  section: RegExp;
  /** What, right after a provision, continues it into a list or a range. */
  continuation: RegExp;
  /**
   * A bare letter continuing a letter path (`písm. g a h`, `písm. g–h`).
   * Only read after a path that ended at a letter: elsewhere a lone letter
   * after `a` is a preposition (`§ 316 a v souladu`), not a provision.
   */
  letterContinuation: RegExp;
  /**
   * A subdivision reference with its value anywhere later in the citation
   * (`§ 316 odst. 2 ZP a odst. 3 ZP`): a second provision past the act name.
   * Sentences are left out: a later `věta druhá` refines the same provision.
   */
  laterSubdivision: RegExp;
  /**
   * A connector and a bare number anywhere later (`§ 316 odst. 2 ZP a 3 ZP`):
   * a continuation past the act name. A gazette number (`č. 262/2006`) is
   * not one, so a number followed by `/` is left alone.
   */
  laterBareContinuation: RegExp;
  /**
   * After a letter path, a connector and a lettered item with its
   * parenthesis anywhere later (`§ 52 písm. g) ZP a h) ZP`). The parenthesis
   * is required here: a bare letter after the act may be a preposition.
   */
  laterLetterContinuation: RegExp;
  /** An and-following marker anywhere (`a násl.`): an open range. */
  andFollowing: RegExp;
  /**
   * A sentence designator with its value (`věta 2`, `věta druhá`), global:
   * it refines the provision wherever it stands, so its number never counts
   * as a further provision.
   */
  sentenceDesignator: RegExp;
  /** A year the profile's version wording introduces, global. */
  versionYear: RegExp;
  sectionUnits: ReadonlyMap<string, SectionUnit>;
  subdivisions: readonly {
    pattern: RegExp;
    level: "subsection" | "letter" | "point" | "sentence";
  }[];
  gazette: RegExp;
  collections: readonly { pattern: RegExp; canonical: string }[];
  acts: readonly {
    spelling: string;
    key: string;
    caseSensitive: boolean;
    entry: ActTitleSpec;
  }[];
};

const compile = (profile: JurisdictionProfile): CompiledResolver => {
  const sectionTerms = profile.sectionTerms.map(({ text }) => text);
  return {
    section: new RegExp(
      String.raw`(?:(?:ust\.?|ustanoven[íi])\s*)?(?<term>${alternation(sectionTerms)})\s*${SECTION_VALUE}`,
      "iu",
    ),
    continuation: new RegExp(
      String.raw`^\s*(?:(?:${alternation(profile.andFollowingMarkers)})|(?:[,;]|[-–—]|(?:${connectorSource(profile)})(?=\s))\s*(?:${alternation(profile.sectionTerms.map(({ text }) => text))}|${alternation(profile.subdivisionTerms.map(({ text }) => text))}|\d|${LETTER}\)))`,
      "iu",
    ),
    laterSubdivision: new RegExp(
      String.raw`(?<![\p{L}\p{N}])(?:${profile.subdivisionTerms
        .filter(({ level }) => level !== "sentence")
        .map(
          ({ text, level }) =>
            String.raw`(?:${termSource(text)})\s*${SUBDIVISION_VALUES[level]}`,
        )
        .join("|")})(?![\p{L}\p{N}])`,
      "iu",
    ),
    laterBareContinuation: new RegExp(
      String.raw`(?:[,;]|[-–—]|(?<![\p{L}\p{N}])(?:${connectorSource(profile)})(?=\s))\s*\d{1,4}[a-z]?(?![\p{L}\p{N}])(?!\s*\/)`,
      "iu",
    ),
    andFollowing: new RegExp(
      String.raw`(?<![\p{L}\p{N}])(?:${alternation(profile.andFollowingMarkers)})`,
      "iu",
    ),
    versionYear: new RegExp(
      String.raw`(?<![\p{L}\p{N}])(?:${alternation(profile.versionYearLeadIns)})\s+(?:(?:roku|r\.)\s+)?(?:1[89]|20)\d{2}(?!\d)`,
      "giu",
    ),
    sentenceDesignator: new RegExp(
      String.raw`(?<![\p{L}\p{N}])(?:${profile.subdivisionTerms
        .filter(({ level }) => level === "sentence")
        .map(({ text }) => termSource(text))
        .join("|")})\s*${SUBDIVISION_VALUES.sentence}(?![\p{L}\p{N}])`,
      "giu",
    ),
    laterLetterContinuation: new RegExp(
      String.raw`(?:[,;]|[-–—]|(?<![\p{L}\p{N}])(?:${connectorSource(profile)})(?=\s))\s*${LETTER}\)`,
      "iu",
    ),
    letterContinuation: new RegExp(
      String.raw`^\s*(?:[,;]|[-–—]|(?:${connectorSource(profile)})(?=\s))\s*${LETTER}(?![\p{L}\p{N}])`,
      "iu",
    ),
    sectionUnits: new Map(
      profile.sectionTerms.map(({ text, unit }) => [foldKey(text), unit]),
    ),
    subdivisions: profile.subdivisionTerms.map(({ text, level }) => ({
      pattern: new RegExp(
        String.raw`^\s*,?\s*(?:${termSource(text)})\s*${SUBDIVISION_VALUES[level]}(?![\p{L}\p{N}])`,
        "iu",
      ),
      level,
    })),
    gazette: /(?:č\.\s*)?(?<number>\d{1,5})\s*\/\s*(?<year>\d{4})(?![\p{N}])/iu,
    collections: profile.collections.flatMap(({ canonical, spellings }) =>
      spellings.map((spelling) => ({
        pattern: new RegExp(
          String.raw`^\s*(?:${RegExp.escape(spelling)})(?![\p{L}\p{N}])`,
          "iu",
        ),
        canonical,
      })),
    ),
    acts: [
      // An alias is case-sensitive (`ZP` is not `zp`); one with lowercase
      // letters (`zák. práce`) is also read without diacritics.
      ...profile.aliases.flatMap((entry) =>
        entry.spellings.flatMap((spelling) => [
          { spelling, key: spelling, caseSensitive: true, entry },
          ...(/\p{Ll}/u.test(spelling)
            ? [
                {
                  spelling,
                  key: foldKey(spelling),
                  caseSensitive: false,
                  entry,
                },
              ]
            : []),
        ]),
      ),
      ...profile.titles.flatMap((entry) =>
        entry.spellings.map((spelling) => ({
          spelling,
          key: foldKey(spelling),
          caseSensitive: false,
          entry,
        })),
      ),
    ].toSorted((left, right) => right.spelling.length - left.spelling.length),
  };
};

const compiled = new WeakMap<JurisdictionProfile, CompiledResolver>();

const compiledFor = (profile: JurisdictionProfile) => {
  let resolver = compiled.get(profile);
  if (resolver === undefined) {
    resolver = compile(profile);
    compiled.set(profile, resolver);
  }
  return resolver;
};

const sameWork = (left: WorkIdentifier, right: WorkIdentifier) =>
  left.number === right.number &&
  left.year === right.year &&
  left.collection === right.collection;

const inWindow = (entry: ActTitleSpec, citedOn: string) =>
  (entry.citedFrom === undefined || citedOn >= entry.citedFrom) &&
  (entry.citedUntil === undefined || citedOn < entry.citedUntil);

/** Whole-word occurrence; folded matching ignores case and diacritics. */
const occurs = (haystack: string, needle: string) => {
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}])${RegExp.escape(needle)}(?![\p{L}\p{N}])`,
    "u",
  );
  return pattern.exec(haystack);
};

type ActRead =
  | { kind: "none" }
  | {
      kind: "works";
      works: WorkIdentifier[];
      units: (SectionUnit | undefined)[];
    };

/**
 * Every act the text names by its gazette number, distinct. More than one
 * (`zákona č. 89/2012 Sb. nebo č. 262/2006 Sb.`) is two acts, which the
 * caller hears about rather than getting the first.
 */
const readGazetteActs = (
  rest: string,
  resolver: CompiledResolver,
  profile: JurisdictionProfile,
): WorkIdentifier[] => {
  // A bare `262/2006` names the national gazette, the profile's statute
  // collection; it is listed after any treaty collection sharing a prefix.
  const statutes =
    profile.collections.find(({ canonical }) => canonical === "Sb.") ??
    profile.collections.find(({ canonical }) => canonical === "Z. z.");
  const works: WorkIdentifier[] = [];
  for (const match of rest.matchAll(
    new RegExp(resolver.gazette.source, "giu"),
  )) {
    const number = Number(match.groups?.["number"]);
    const year = Number(match.groups?.["year"]);
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      year < profile.earliestYear
    ) {
      continue;
    }
    const after = rest.slice(match.index + match[0].length);
    const canonical =
      resolver.collections.find(({ pattern }) => pattern.test(after))
        ?.canonical ?? statutes?.canonical;
    if (canonical === undefined) {
      continue;
    }
    const work = { number, year, collection: canonical };
    if (!works.some((known) => sameWork(known, work))) {
      works.push(work);
    }
  }
  return works;
};

/**
 * Every act entry a spelling in the text names, whatever its window.
 * Longest spellings first: a shorter one inside a longer match is the same
 * words (`zákoník` inside `zákoník práce`) and is dropped, but a spelling
 * elsewhere in the text names another act and is kept, so two acts named
 * side by side (`občanského zákoníku nebo ZP`) are reported, not one picked.
 */
type NamedActMatch = { start: number; end: number; entry: ActTitleSpec };

const matchNamedActs = (
  rest: string,
  resolver: CompiledResolver,
): NamedActMatch[] => {
  const folded = foldKey(rest);
  const accepted: NamedActMatch[] = [];
  for (const act of resolver.acts) {
    const found = act.caseSensitive
      ? occurs(rest, act.key)
      : occurs(folded, act.key);
    if (found === null) {
      continue;
    }
    const start = found.index;
    const end = start + found[0].length;
    const insideLonger = accepted.some(
      (match) =>
        match.start < end &&
        start < match.end &&
        match.end - match.start > end - start,
    );
    if (!insideLonger) {
      accepted.push({ start, end, entry: act.entry });
    }
  }
  return accepted;
};

const readNamedAct = (
  rest: string,
  resolver: CompiledResolver,
  citedOn: string,
): ActRead => {
  const matches = matchNamedActs(rest, resolver);
  if (matches.length === 0) {
    return { kind: "none" };
  }
  // Window precedence is per spelling: a spelling two acts bore in turn names
  // the one its window covers, and an unbounded entry of that spelling
  // applies only where no bounded one does. Another spelling elsewhere in the
  // citation is read on its own, so a dated title never hides an unrelated
  // undated name beside it.
  const spans = new Map<string, ActTitleSpec[]>();
  for (const { start, end, entry } of matches) {
    const key = `${String(start)}:${String(end)}`;
    spans.set(key, [...(spans.get(key) ?? []), entry]);
  }
  const chosen = [...spans.values()].flatMap((entries) => {
    const windowed = entries.filter(
      (entry) =>
        (entry.citedFrom !== undefined || entry.citedUntil !== undefined) &&
        inWindow(entry, citedOn),
    );
    return windowed.length > 0
      ? windowed
      : entries.filter(
          (entry) =>
            entry.citedFrom === undefined && entry.citedUntil === undefined,
        );
  });
  const works: WorkIdentifier[] = [];
  const units: (SectionUnit | undefined)[] = [];
  for (const entry of chosen) {
    if (!works.some((work) => sameWork(work, entry.identifier))) {
      works.push(entry.identifier);
      units.push(entry.unit);
    }
  }
  return works.length === 0
    ? { kind: "none" }
    : { kind: "works", works, units };
};

type ProvisionPath = Pick<
  ResolvedProvisionCitation,
  "unit" | "section" | "sectionSuffix" | "subsection" | "letter" | "point"
>;

const renderCitation = (
  profile: JurisdictionProfile,
  provision: ProvisionPath,
  workIdentifier: string,
) => {
  const terms = profile.citationTerms;
  const parts = [
    `${provision.unit === "article" ? terms.article : terms.section} ${String(provision.section)}${provision.sectionSuffix ?? ""}`,
  ];
  if (provision.subsection !== null) {
    parts.push(`${terms.subsection} ${provision.subsection}`);
  }
  if (provision.letter !== null) {
    parts.push(`${terms.letter} ${provision.letter})`);
  }
  if (provision.point !== null) {
    parts.push(`${terms.point} ${provision.point}`);
  }
  return `${parts.join(" ")} ${workIdentifier}`;
};

/**
 * The publisher anchor of a provision path, in the profile's scheme: one
 * segment per named level, the same anchor a resolved citation carries.
 */
export const renderProvisionAnchor = (
  profile: JurisdictionProfile,
  resolved: ProvisionPath,
): string => {
  const { render, join } = profile.anchor;
  const segments = [
    render[resolved.unit](
      `${String(resolved.section)}${resolved.sectionSuffix ?? ""}`,
    ),
  ];
  if (resolved.subsection !== null) {
    segments.push(render.subsection(resolved.subsection));
  }
  if (resolved.letter !== null) {
    segments.push(render.letter(resolved.letter));
  }
  if (resolved.point !== null) {
    segments.push(render.point(resolved.point));
  }
  return segments.join(join);
};

const SECTION_DESIGNATOR = /^(?<number>\d+)(?<suffix>\p{Ll}*)$/u;

/**
 * The provision path a publisher anchor names, read through the same scheme
 * that minted it. Only an anchor that renders back to itself is read, so
 * anything else (a heading id, a reordered path) names no provision.
 */
const parseAnchor = (
  profile: JurisdictionProfile,
  anchor: string,
): ProvisionPath | null => {
  const { render, join } = profile.anchor;
  const [head, ...rest] = anchor.split(join);
  const unit = SECTION_UNITS.find((candidate) =>
    head?.startsWith(render[candidate]("")),
  );
  if (head === undefined || unit === undefined) {
    return null;
  }
  const designator = SECTION_DESIGNATOR.exec(
    head.slice(render[unit]("").length),
  )?.groups;
  if (designator?.["number"] === undefined) {
    return null;
  }
  const subdivisions = Object.fromEntries(
    ANCHORED_SUBDIVISION_LEVELS.map((level) => {
      const prefix = render[level]("");
      const segment = rest.find((part) => part.startsWith(prefix));
      return [level, segment?.slice(prefix.length) ?? null] as const;
    }),
  );
  const path: ProvisionPath = {
    unit,
    section: Number(designator["number"]),
    sectionSuffix:
      designator["suffix"] === undefined || designator["suffix"] === ""
        ? null
        : designator["suffix"],
    subsection: subdivisions["subsection"] ?? null,
    letter: subdivisions["letter"] ?? null,
    point: subdivisions["point"] ?? null,
  };
  return renderProvisionAnchor(profile, path) === anchor ? path : null;
};

/**
 * How a publisher anchor reads printed (`par_106-odst_4` in `262/2006 Sb.` is
 * `§ 106 odst. 4 262/2006 Sb.`), in the spelling a resolved citation echoes.
 * Null where the jurisdiction has no profile, or the anchor names no
 * provision under it.
 */
export const anchorProvisionCitation = ({
  anchor,
  jurisdiction,
  workIdentifier,
}: {
  anchor: string;
  jurisdiction: string;
  workIdentifier: string;
}): string | null => {
  const profile = provisionCitationProfileFor(jurisdiction);
  const path = profile === null ? null : parseAnchor(profile, anchor);
  return profile === null || path === null
    ? null
    : renderCitation(profile, path, workIdentifier);
};

const DATE_PATTERN = /\d{1,2}\.\s*\d{1,2}\.\s*\d{4}/gu;
const LETTERED_ITEM = new RegExp(
  String.raw`(?<![\p{L}\p{N}])${LETTER}\)`,
  "iu",
);

/**
 * Whether the text after the first provision still names another one once
 * everything a single citation may carry there is set aside: act names,
 * gazette numbers, and the dates and years of a version. Any number, lettered
 * item or and-following marker left over belongs to a further provision,
 * however it is joined (`§ 316 odst. 2 ZP a 3 ZP`, `§ 2910 OZ a násl.`), so
 * the filter is refused rather than narrowed to the first. Structural, not a
 * list of joining forms.
 */
const namesFurtherProvision = (
  after: string,
  resolver: CompiledResolver,
): boolean => {
  const blank = (text: string, start: number, end: number) =>
    `${text.slice(0, start)}${" ".repeat(end - start)}${text.slice(end)}`;
  let residual = after.replace(
    new RegExp(resolver.gazette.source, "giu"),
    (match) => " ".repeat(match.length),
  );
  for (const { start, end } of matchNamedActs(residual, resolver)) {
    residual = blank(residual, start, end);
  }
  residual = residual
    .replace(resolver.sentenceDesignator, (match) => " ".repeat(match.length))
    .replace(DATE_PATTERN, (match) => " ".repeat(match.length))
    // Only a year the version wording introduces: `plus 2021` is a number.
    .replace(resolver.versionYear, (match) => " ".repeat(match.length));
  return (
    /\d/u.test(residual) ||
    LETTERED_ITEM.test(residual) ||
    resolver.andFollowing.test(residual)
  );
};

type SubdivisionPath = {
  subsection: string | null;
  letter: string | null;
  point: string | null;
};

const canonicalValue = (value: string) =>
  value.toLowerCase().replace(/^0+(?=\d)/u, "");

/**
 * The subdivisions printed after a section, read until text stops naming
 * one, with where the path ends. A sentence designator is read and dropped:
 * publisher anchors stop at points.
 */
const readSubdivisionPath = (
  text: string,
  start: number,
  resolver: CompiledResolver,
): { path: SubdivisionPath; end: number; repeated: boolean } => {
  let path: SubdivisionPath = { subsection: null, letter: null, point: null };
  // A level named twice (`odst. 2, odst. 3`) is two provisions, never the
  // last one read.
  let repeated = false;
  let cursor = start;
  // `§ 316/2` is the shorthand for a subsection.
  const slash = /^\s*\/\s*(?<value>\d{1,4}[a-z]?)(?![\p{L}\p{N}])/iu.exec(
    text.slice(cursor),
  );
  const slashValue = slash?.groups?.["value"];
  if (slash !== null && slashValue !== undefined) {
    path = { ...path, subsection: canonicalValue(slashValue) };
    cursor += slash[0].length;
  }
  for (;;) {
    const remaining = text.slice(cursor);
    const step = resolver.subdivisions
      .map(({ pattern, level }) => ({ match: pattern.exec(remaining), level }))
      .find(({ match }) => match !== null);
    const match = step?.match ?? null;
    const value = match?.groups?.["value"];
    if (step === undefined || match === null || value === undefined) {
      return { path, end: cursor, repeated };
    }
    switch (step.level) {
      case "subsection":
        repeated ||= path.subsection !== null;
        path = { ...path, subsection: canonicalValue(value) };
        break;
      case "letter":
        repeated ||= path.letter !== null;
        path = { ...path, letter: canonicalValue(value) };
        break;
      case "point":
        repeated ||= path.point !== null;
        path = { ...path, point: canonicalValue(value) };
        break;
      case "sentence":
        break;
      default:
        step.level satisfies never;
        return panic(`Unknown subdivision level ${String(step.level)}`);
    }
    cursor += match[0].length;
  }
};

type ActRefusal = Extract<
  ProvisionCitationResolution,
  { status: "no_act" | "ambiguous_act" }
>;

type ActResolution =
  | { kind: "work"; work: WorkIdentifier; unit: SectionUnit | undefined }
  | { kind: "refused"; resolution: ActRefusal };

/**
 * The act the rest of the citation names: a gazette number outright, else
 * an alias or title read for the citing date. `unit` is undefined only for a
 * number the profile does not list, whose unit nothing can check.
 */
const resolveAct = (
  rest: string,
  resolver: CompiledResolver,
  profile: JurisdictionProfile,
  citedOn: string,
): ActResolution => {
  const numbered = readGazetteActs(rest, resolver, profile);
  if (numbered.length > 1) {
    return {
      kind: "refused",
      resolution: {
        status: "ambiguous_act",
        candidates: numbered.map((work) => ({
          work,
          workIdentifier: formatWorkIdentifier(work),
        })),
      },
    };
  }
  const [gazette] = numbered;
  if (gazette !== undefined) {
    // A name beside the number must be one the numbered act ever bore, in
    // any window (`č. 40/1964 Sb., občanský zákoník` is the old code by
    // number); a name of another act (`ZP č. 89/2012 Sb.`) makes it two.
    // Each name is checked on its own: one matching title must not excuse
    // a conflicting one beside it (`č. 89/2012 Sb., občanský zákoník nebo
    // ZP`). Entries at one span are one spelling read by its windows.
    const named = matchNamedActs(rest, resolver);
    const spans = new Map<string, NamedActMatch[]>();
    for (const match of named) {
      const key = `${String(match.start)}:${String(match.end)}`;
      spans.set(key, [...(spans.get(key) ?? []), match]);
    }
    const conflicting = [...spans.values()].filter(
      (group) =>
        !group.some(({ entry }) => sameWork(entry.identifier, gazette)),
    );
    if (conflicting.length > 0) {
      const candidates: WorkIdentifier[] = [gazette];
      for (const { entry } of conflicting.flat()) {
        if (!candidates.some((work) => sameWork(work, entry.identifier))) {
          candidates.push(entry.identifier);
        }
      }
      return {
        kind: "refused",
        resolution: {
          status: "ambiguous_act",
          candidates: candidates.map((work) => ({
            work,
            workIdentifier: formatWorkIdentifier(work),
          })),
        },
      };
    }
    // A number the profile knows carries that act's unit (`§ 10 zákona
    // č. 2/1993 Sb.` names the Charter, which has articles); an act the
    // profile does not list is taken as numbered.
    const known = resolver.acts.find(({ entry }) =>
      sameWork(entry.identifier, gazette),
    );
    return {
      kind: "work",
      work: gazette,
      unit: known === undefined ? undefined : (known.entry.unit ?? "section"),
    };
  }
  const named = readNamedAct(rest, resolver, citedOn);
  const [work, ...others] = named.kind === "none" ? [] : named.works;
  if (named.kind === "none" || work === undefined) {
    return { kind: "refused", resolution: { status: "no_act" } };
  }
  if (others.length > 0) {
    return {
      kind: "refused",
      resolution: {
        status: "ambiguous_act",
        candidates: named.works.map((candidate) => ({
          work: candidate,
          workIdentifier: formatWorkIdentifier(candidate),
        })),
      },
    };
  }
  return { kind: "work", work, unit: named.units[0] ?? "section" };
};

/**
 * Reads one provision citation against a jurisdiction's citation profile:
 * the same aliases, titles, collections and recodification windows the
 * corpus extraction reads, so a provision a caller names resolves to the
 * identity the corpus links decisions to.
 */
export const resolveProvisionCitation = ({
  text,
  profile,
  citedOn,
}: ResolveOptions): ProvisionCitationResolution => {
  const resolver = compiledFor(profile);
  const normalized = normalize(text);
  const section = resolver.section.exec(normalized);
  const term = section?.groups?.["term"];
  const number = section?.groups?.["number"];
  if (section === null || term === undefined || number === undefined) {
    return { status: "no_provision" };
  }
  // A term typed without its period (`cl 10`) is the same term.
  const termKey = foldKey(term);
  const unit =
    resolver.sectionUnits.get(termKey) ??
    resolver.sectionUnits.get(`${termKey}.`) ??
    "section";
  const { path, end, repeated } = readSubdivisionPath(
    normalized,
    section.index + section[0].length,
    resolver,
  );
  const after = normalized.slice(end);
  if (
    // `§§` is the plural designator: it always introduces more than one.
    term.startsWith("§§") ||
    repeated ||
    resolver.continuation.test(after) ||
    (path.letter !== null && resolver.letterContinuation.test(after)) ||
    // A second provision anywhere after the first (`§ 316 ZP a § 317 ZP`),
    // past an act name the continuation check cannot see across.
    resolver.section.test(after) ||
    resolver.laterSubdivision.test(after) ||
    resolver.laterBareContinuation.test(after) ||
    (path.letter !== null && resolver.laterLetterContinuation.test(after)) ||
    namesFurtherProvision(after, resolver)
  ) {
    return { status: "multiple_provisions" };
  }
  const rest = `${normalized.slice(0, section.index)} ${normalized.slice(end)}`;
  const act = resolveAct(rest, resolver, profile, citedOn);
  if (act.kind === "refused") {
    return act.resolution;
  }
  const workIdentifier = formatWorkIdentifier(act.work);
  if (act.unit !== undefined && act.unit !== unit) {
    return { status: "unit_mismatch", work: act.work, workIdentifier };
  }
  const suffix = section.groups?.["suffix"];
  const resolved = {
    work: act.work,
    workIdentifier,
    unit,
    section: Number.parseInt(number, 10),
    sectionSuffix: suffix === undefined ? null : suffix.toLowerCase(),
    ...path,
  };
  return {
    status: "resolved",
    ...resolved,
    anchor: renderProvisionAnchor(profile, resolved),
    citation: renderCitation(profile, resolved, resolved.workIdentifier),
  };
};

type ActCitationResolution =
  | { status: "resolved"; work: WorkIdentifier; workIdentifier: string }
  /** `actName` is the words that name the act, any provision set aside. */
  | { status: "no_act"; actName: string }
  | Extract<ProvisionCitationResolution, { status: "ambiguous_act" }>;

/** Brackets and separators around an act name once its provision is cut. */
const LEADING_NAME_EDGES = new Set(["[", "(", ",", ";", ":"]);
const TRAILING_NAME_EDGES = new Set(["]", ")", ",", ";", ":"]);
const WHITESPACE = /^\s$/u;

// A scan from each end rather than an anchored regex: alternating `+` runs
// backtrack quadratically on a long run of separators.
const trimNameEdges = (text: string): string => {
  let start = 0;
  let end = text.length;
  while (
    start < end &&
    (LEADING_NAME_EDGES.has(text.charAt(start)) ||
      WHITESPACE.test(text.charAt(start)))
  ) {
    start += 1;
  }
  while (
    end > start &&
    (TRAILING_NAME_EDGES.has(text.charAt(end - 1)) ||
      WHITESPACE.test(text.charAt(end - 1)))
  ) {
    end -= 1;
  }
  return text.slice(start, end);
};

/**
 * Where a version statement (`ve znění pozdějších předpisů`, `ve znění zákona
 * č. …`, `ve znění účinném do …`) starts, or the text's end: the act's name
 * comes before it, and a corpus lookup with it attached misses the name.
 */
const versionStatementStart = (
  text: string,
  { versionGrammar }: JurisdictionProfile,
): number => {
  const lower = text.toLowerCase();
  let start = text.length;
  for (const phrase of [
    ...versionGrammar.currentVersionMarkers,
    ...versionGrammar.amendmentPrefixes,
    ...versionGrammar.dateStatements.map(({ prefix }) => prefix),
  ]) {
    const at = lower.indexOf(phrase.toLowerCase());
    if (
      at !== -1 &&
      at < start &&
      (at === 0 || /[\s,;(]/u.test(lower.charAt(at - 1)))
    ) {
      start = at;
    }
  }
  return start;
};

const actNameOf = (text: string, profile: JurisdictionProfile) => {
  const normalized = normalize(text);
  return trimNameEdges(
    normalized.slice(0, versionStatementStart(normalized, profile)),
  );
};

/**
 * The act a citation names, read as `resolveProvisionCitation` reads it: by
 * gazette number, alias or title for the citing date. A provision printed
 * with it (`§ 2 odst. 4 písm. b) zákona …`) is set aside, so a citation
 * names its act with or without one.
 */
export const resolveActCitation = ({
  text,
  profile,
  citedOn,
}: ResolveOptions): ActCitationResolution => {
  const resolver = compiledFor(profile);
  const normalized = normalize(text);
  const section = resolver.section.exec(normalized);
  const before =
    section === null ? normalized : normalized.slice(0, section.index);
  const after =
    section === null
      ? ""
      : normalized.slice(
          readSubdivisionPath(
            normalized,
            section.index + section[0].length,
            resolver,
          ).end,
        );
  const act = resolveAct(`${before} ${after}`, resolver, profile, citedOn);
  if (act.kind === "work") {
    return {
      status: "resolved",
      work: act.work,
      workIdentifier: formatWorkIdentifier(act.work),
    };
  }
  switch (act.resolution.status) {
    case "no_act": {
      // An act's name follows the provision it is cited for (`§ 2 zákona
      // o …`); what precedes it is a lead-in (`Z § 2 …`, `ustanovení § 2`).
      const named = actNameOf(after, profile);
      return {
        status: "no_act",
        actName: named === "" ? actNameOf(before, profile) : named,
      };
    }
    case "ambiguous_act":
      return act.resolution;
    default:
      act.resolution satisfies never;
      return panic("Unknown act resolution");
  }
};

/**
 * The name with its head in the nominative (`zákona o obětech trestných
 * činů` → `zákon o obětech trestných činů`), the form a stored title states;
 * null when the name is not a head of the profile followed by more words.
 */
export const nominativeTitle = (
  name: string,
  profile: JurisdictionProfile,
): string | null => {
  const [head = "", ...words] = normalize(name).split(" ");
  const lowered = head.toLowerCase();
  const spec = profile.titleHeads.find(({ forms }) => forms.includes(lowered));
  if (spec === undefined || words.length === 0) {
    return null;
  }
  return [spec.nominative, ...words].join(" ");
};
