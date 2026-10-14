import { panic } from "better-result";

import { foldToAscii, normalizeUnicode } from "@stll/text-normalize";

import {
  type ActTitleSpec,
  formatWorkIdentifier,
  type JurisdictionProfile,
  type SectionUnit,
  type WorkIdentifier,
} from "./provision-citation-profile";

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
/** What each level's value looks like; a sentence is read only to be skipped. */
const SUBDIVISION_VALUES = {
  subsection: String.raw`(?<value>\d{1,4}[a-z]?)`,
  letter: String.raw`(?<value>[a-z])\)?`,
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

const alternation = (texts: readonly string[]) =>
  texts
    .toSorted((left, right) => right.length - left.length)
    .map(termSource)
    .join("|");

type CompiledResolver = {
  section: RegExp;
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

const readGazetteAct = (
  rest: string,
  resolver: CompiledResolver,
  profile: JurisdictionProfile,
): WorkIdentifier | null => {
  const match = resolver.gazette.exec(rest);
  const number = Number(match?.groups?.["number"]);
  const year = Number(match?.groups?.["year"]);
  if (
    match === null ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    year < profile.earliestYear
  ) {
    return null;
  }
  const after = rest.slice(match.index + match[0].length);
  const collection =
    resolver.collections.find(({ pattern }) => pattern.test(after))
      ?.canonical ?? null;
  // A bare `262/2006` names the national gazette, the profile's statute
  // collection; it is listed after any treaty collection sharing a prefix.
  const statutes =
    profile.collections.find(({ canonical }) => canonical === "Sb.") ??
    profile.collections.find(({ canonical }) => canonical === "Z. z.");
  const canonical = collection ?? statutes?.canonical;
  return canonical === undefined
    ? null
    : { number, year, collection: canonical };
};

const readNamedAct = (
  rest: string,
  resolver: CompiledResolver,
  citedOn: string,
): ActRead => {
  const folded = foldKey(rest);
  let longest = 0;
  const matches: ActTitleSpec[] = [];
  for (const act of resolver.acts) {
    if (act.spelling.length < longest) {
      break;
    }
    const found = act.caseSensitive
      ? occurs(rest, act.key)
      : occurs(folded, act.key);
    if (found === null) {
      continue;
    }
    longest = act.spelling.length;
    matches.push(act.entry);
  }
  if (matches.length === 0) {
    return { kind: "none" };
  }
  // A spelling two acts bore in turn names the one its window covers; an
  // unbounded entry applies only where no bounded one of it does.
  const bounded = matches.filter(
    (entry) => entry.citedFrom !== undefined || entry.citedUntil !== undefined,
  );
  const windowed = bounded.filter((entry) => inWindow(entry, citedOn));
  const chosen =
    windowed.length > 0
      ? windowed
      : matches.filter(
          (entry) =>
            entry.citedFrom === undefined && entry.citedUntil === undefined,
        );
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

const renderCitation = (
  resolved: Omit<ResolvedProvisionCitation, "status" | "anchor" | "citation">,
) => {
  const parts = [
    `${resolved.unit === "article" ? "čl." : "§"} ${String(resolved.section)}${resolved.sectionSuffix ?? ""}`,
  ];
  if (resolved.subsection !== null) {
    parts.push(`odst. ${resolved.subsection}`);
  }
  if (resolved.letter !== null) {
    parts.push(`písm. ${resolved.letter})`);
  }
  if (resolved.point !== null) {
    parts.push(`bod ${resolved.point}`);
  }
  return `${parts.join(" ")} ${resolved.workIdentifier}`;
};

const renderAnchor = (
  profile: JurisdictionProfile,
  resolved: Pick<
    ResolvedProvisionCitation,
    "unit" | "section" | "sectionSuffix" | "subsection" | "letter" | "point"
  >,
) => {
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
): { path: SubdivisionPath; end: number } => {
  let path: SubdivisionPath = { subsection: null, letter: null, point: null };
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
      return { path, end: cursor };
    }
    switch (step.level) {
      case "subsection":
        path = { ...path, subsection: canonicalValue(value) };
        break;
      case "letter":
        path = { ...path, letter: canonicalValue(value) };
        break;
      case "point":
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

type ActResolution =
  | { kind: "work"; work: WorkIdentifier; unit: SectionUnit | undefined }
  | { kind: "refused"; resolution: ProvisionCitationResolution };

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
  const gazette = readGazetteAct(rest, resolver, profile);
  if (gazette !== null) {
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
  const { path, end } = readSubdivisionPath(
    normalized,
    section.index + section[0].length,
    resolver,
  );
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
    anchor: renderAnchor(profile, resolved),
    citation: renderCitation(resolved),
  };
};
