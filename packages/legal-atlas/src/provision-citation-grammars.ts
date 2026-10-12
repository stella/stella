/**
 * How each jurisdiction prints a statute citation, and where it links.
 *
 * Section syntax, the abbreviations a court uses for its own acts, the
 * gazette a work is cited by, and the anchor ids its statute AST carries are
 * all jurisdiction-bound. The map is therefore total over the corpus
 * jurisdictions: a decision whose jurisdiction has no grammar reads its
 * citations as text, and onboarding one is an entry here, never another
 * country's typography applied by default.
 *
 * What is not jurisdiction-bound is the shape of a citation: a path of
 * levels (section, subsection, letter, point), each a designator plus a
 * value, and coordination that repeats only the part that changes
 * (`odst. 1 a 2`, `§§ 60 a 120`, `ust. 1 i 2`). The parser owns that shape;
 * a grammar supplies the designators, the values, and the connectors.
 */
import { panic } from "better-result";

import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import { CZE_CASE_LAW_REPORTER_SUFFIX_SOURCE } from "@stll/api-contract/statute-gazette";
import type {
  ProvisionReference,
  ProvisionUnit,
} from "@stll/legal-ast/provision-reference";
import { normalizeUnicode } from "@stll/text-normalize";

import { CZ_STATUTE_COLLECTION } from "./cz-provision-citation-profile";
import { formatWorkIdentifier } from "./provision-citation-profile";

export type StatuteAbbreviationEntry = {
  canonicalAbbreviation: string;
  eli: string;
  /** RegExp source accepting exactly this jurisdiction's printed variants. */
  patternSource: string;
};

export type StatuteAbbreviation = Pick<
  StatuteAbbreviationEntry,
  "canonicalAbbreviation" | "eli"
>;

/** One printed provision, located in the text it was read from. */
export type LocatedProvisionCitation = {
  abbreviation: StatuteAbbreviation;
  /** The anchor id the provision lands on in the statute AST. */
  anchor: string;
  end: number;
  /** Jurisdiction of the cited work, which is the citing court's own. */
  jurisdiction: CaseLawJurisdiction;
  reference: ProvisionReference;
  start: number;
};

/** One work cited by its gazette number, located in the text. */
export type LocatedGazetteCitation = {
  eli: string;
  end: number;
  jurisdiction: CaseLawJurisdiction;
  start: number;
};

type GazetteWork = { number: string; year: string };

/** The subdivisions a citation path can name, outermost first. */
export type ProvisionLevelKey = "section" | "subsection" | "letter" | "point";

export type ProvisionLevel = {
  key: ProvisionLevelKey;
  /** RegExp source for the designator that opens this level (`§§?`, `odst\.`). */
  marker: string;
  /**
   * RegExp source for the value. A `value` group narrows what is kept, so
   * typography can be matched and dropped (`(?<value>[a-z])\)?`).
   */
  value: string;
  /** Publisher anchor prefix for this level, including its delimiter. */
  anchorMarker: string;
};

type ProvisionCitationGrammarSpec<TJurisdiction extends CaseLawJurisdiction> = {
  /** Abbreviations courts of this jurisdiction use for its own acts. */
  abbreviations: readonly StatuteAbbreviationEntry[];
  anchorSeparator: string;
  /**
   * RegExp sources that join provisions in one citation (`,`, `a`, `i`).
   * Whitespace around a connector is the parser's; a word connector guards
   * its own end (`a(?=\s)`) so it does not open a longer word.
   */
  connectors: readonly string[];
  gazette: {
    eli: (work: GazetteWork) => string;
    identifier: (work: GazetteWork) => string;
    /** RegExp source with `number` and `year` groups, no flags. */
    source: string;
  };
  jurisdiction: TJurisdiction;
  /**
   * The citation path, outermost level first, starting with `section`. A
   * printed citation names a prefix of it; coordination continues at the
   * level it names.
   */
  levels: readonly [ProvisionLevel, ...ProvisionLevel[]];
  unit: ProvisionUnit;
};

export type SupportedProvisionCitationGrammar<
  TJurisdiction extends CaseLawJurisdiction = CaseLawJurisdiction,
> = {
  anchor: (reference: ProvisionReference) => string;
  parseAnchor: (raw: string) => ProvisionReference | null;
  unit: ProvisionUnit;
  gazette: {
    eli: (work: GazetteWork) => string;
    parse: (raw: string) => { identifier: string; eli: string } | null;
  };
  jurisdiction: TJurisdiction;
  locateAbbreviatedProvisions: (text: string) => LocatedProvisionCitation[];
  locateGazetteCitations: (text: string) => LocatedGazetteCitation[];
  parseReference: (raw: string) => ProvisionReference | null;
  normalizeReference: (
    reference: ProvisionReference,
  ) => ProvisionReference | null;
  status: "supported";
};

export type ProvisionCitationGrammar<
  TJurisdiction extends CaseLawJurisdiction = CaseLawJurisdiction,
> =
  | SupportedProvisionCitationGrammar<TJurisdiction>
  | { jurisdiction: TJurisdiction; status: "unsupported" };

const SECTION_VALUE = /^(?<number>\d+)(?<suffix>\p{L}*)$/u;
const WHITESPACE = /\s*/uy;
/** A bare coordinated value must end where a word ends, or `a) a s. ř. s.` reads `s` as a letter. */
const VALUE_BOUNDARY = /(?![\p{L}\p{N}])/uy;

type CompiledLevel = {
  key: ProvisionLevelKey;
  marker: RegExp;
  value: RegExp;
};

/** One printed element of a chain, with every level it names or inherits. */
type ChainElement = {
  end: number;
  start: number;
  values: readonly (string | null)[];
};

const sticky = (source: string): RegExp => new RegExp(source, "iuy");

const matchAt = (
  pattern: RegExp,
  text: string,
  index: number,
): RegExpExecArray | null => {
  pattern.lastIndex = index;
  return pattern.exec(text);
};

const afterWhitespace = (text: string, index: number): number => {
  const gap = matchAt(WHITESPACE, text, index);
  return gap === null ? index : gap.index + gap[0].length;
};

const canonicalDesignator = (value: string): string =>
  value.replace(/^0+(?=\d)/u, "");

const valueOf = (match: RegExpExecArray): string =>
  canonicalDesignator((match.groups?.["value"] ?? match[0]).toLowerCase());

const referenceOf = (
  levels: readonly CompiledLevel[],
  values: readonly (string | null)[],
  unit: ProvisionUnit,
): ProvisionReference | null => {
  const reference: ProvisionReference = {
    letter: null,
    openEnded: false,
    point: null,
    section: Number.NaN,
    sectionSuffix: null,
    sentence: null,
    subsection: null,
    unit,
  };
  for (const [index, level] of levels.entries()) {
    const value = values[index] ?? null;
    if (value === null) {
      continue;
    }
    switch (level.key) {
      case "section": {
        const parts = SECTION_VALUE.exec(value)?.groups;
        const number = parts?.["number"];
        if (number === undefined) {
          return null;
        }
        reference.section = Number.parseInt(number, 10);
        const suffix = parts?.["suffix"];
        reference.sectionSuffix =
          suffix === undefined || suffix.length === 0 ? null : suffix;
        break;
      }
      case "subsection":
        reference.subsection = value;
        break;
      case "letter":
        reference.letter = value;
        break;
      case "point":
        reference.point = value;
        break;
      default:
        level.key satisfies never;
        return panic(`Unknown provision level ${String(level.key)}`);
    }
  }
  return Number.isNaN(reference.section) ? null : reference;
};

const deepestNamed = (values: readonly (string | null)[]): number => {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== null) {
      return index;
    }
  }
  return -1;
};

/**
 * Compiles one jurisdiction's declarative spec. Abbreviation patterns own
 * their punctuation and spacing; resolution applies only NFC, and an
 * abbreviation two entries accept resolves to neither.
 */
export const createProvisionCitationGrammar = <
  const TJurisdiction extends CaseLawJurisdiction,
>({
  abbreviations,
  anchorSeparator,
  connectors,
  gazette,
  jurisdiction,
  levels,
  unit,
}: ProvisionCitationGrammarSpec<TJurisdiction>): SupportedProvisionCitationGrammar<TJurisdiction> => {
  const compiledLevels: CompiledLevel[] = levels.map(
    ({ key, marker, value }) => ({
      key,
      marker: sticky(marker),
      value: new RegExp(value, "uy"),
    }),
  );
  const anchor = (reference: ProvisionReference): string =>
    levels
      .flatMap((level) => {
        const value =
          level.key === "section"
            ? `${String(reference.section)}${reference.sectionSuffix ?? ""}`
            : reference[level.key];
        return value === null
          ? []
          : [`${level.anchorMarker}${canonicalDesignator(value)}`];
      })
      .join(anchorSeparator);
  const parseAnchor = (raw: string): ProvisionReference | null => {
    const parts = raw.split(anchorSeparator);
    const values: (string | null)[] = [];
    let index = 0;
    for (const level of levels) {
      const part = parts.at(index);
      if (part === undefined || !part.startsWith(level.anchorMarker)) {
        values.push(null);
        continue;
      }
      const value = part.slice(level.anchorMarker.length);
      const compiled = compiledLevels.at(values.length);
      if (compiled === undefined) {
        return null;
      }
      const match = matchAt(compiled.value, value, 0);
      if (match === null || match[0].length !== value.length) {
        return null;
      }
      values.push(valueOf(match));
      index++;
    }
    if (index !== parts.length) {
      return null;
    }
    return referenceOf(compiledLevels, values, unit);
  };
  const head = new RegExp(levels[0].marker, "giu");
  const connector = sticky(`\\s*(?:${connectors.join("|")})\\s*`);
  const abbreviationAfter =
    abbreviations.length === 0
      ? null
      : sticky(
          `\\s+(?<abbreviation>${abbreviations
            .map(({ patternSource }) => `(?:${patternSource})`)
            .join("|")})`,
        );
  const matchers = abbreviations.map((entry) => ({
    entry,
    matcher: new RegExp(`^(?:${entry.patternSource})$`, "iu"),
  }));
  const gazettePattern = new RegExp(gazette.source, "giu");

  const resolveAbbreviation = (printed: string): StatuteAbbreviation | null => {
    const normalized = normalizeUnicode(printed, "NFC");
    const matched = matchers.filter(({ matcher }) => matcher.test(normalized));
    const only = matched.length === 1 ? matched.at(0) : undefined;
    return only === undefined
      ? null
      : {
          canonicalAbbreviation: only.entry.canonicalAbbreviation,
          eli: only.entry.eli,
        };
  };

  /**
   * A designator-led element opening at level `from`, inheriting the levels
   * above it. `§ 46 odst. 1` opens at level 0 with nothing inherited;
   * `odst. 2` after a connector opens at level 1 inheriting section 46. A
   * level a citation leaves out (`§ 5 písm. a)`, `art. 7 pkt 3`) stays
   * unnamed; the element ends at the first designator whose value is missing.
   */
  const parseElement = (
    text: string,
    index: number,
    from: number,
    inherited: readonly (string | null)[],
  ): ChainElement | null => {
    const values = [...inherited.slice(0, from)];
    let position = index;
    for (const [offset, level] of compiledLevels.slice(from).entries()) {
      const marker = matchAt(
        level.marker,
        text,
        afterWhitespace(text, position),
      );
      if (marker === null) {
        if (offset === 0) {
          return null;
        }
        values.push(null);
        continue;
      }
      const value = matchAt(
        level.value,
        text,
        afterWhitespace(text, marker.index + marker[0].length),
      );
      if (value === null) {
        if (offset === 0) {
          return null;
        }
        break;
      }
      values.push(valueOf(value));
      position = value.index + value[0].length;
    }
    while (values.length < compiledLevels.length) {
      values.push(null);
    }
    return { end: position, start: index, values };
  };

  /** A bare value continuing the previous element at its deepest level. */
  const parseCoordinatedValue = (
    text: string,
    index: number,
    previous: ChainElement,
  ): ChainElement | null => {
    const depth = deepestNamed(previous.values);
    const level = compiledLevels[depth];
    if (level === undefined) {
      return null;
    }
    const value = matchAt(level.value, text, index);
    if (value === null) {
      return null;
    }
    const end = value.index + value[0].length;
    if (matchAt(VALUE_BOUNDARY, text, end) === null) {
      return null;
    }
    const values = [...previous.values];
    values[depth] = valueOf(value);
    return { end, start: index, values };
  };

  const parseNext = (
    text: string,
    index: number,
    previous: ChainElement,
  ): ChainElement | null => {
    for (let from = 0; from < compiledLevels.length; from += 1) {
      const element = parseElement(text, index, from, previous.values);
      if (element !== null) {
        return element;
      }
    }
    return parseCoordinatedValue(text, index, previous);
  };

  type Chain = { abbreviation: string; elements: ChainElement[]; end: number };

  /**
   * The chain opened by a designator at `index`, if an abbreviation closes
   * it. Coordination is read greedily and given back one element at a time
   * when no abbreviation follows, so a connector that opened prose rather
   * than a further provision costs the chain nothing.
   */
  const parseChain = (text: string, index: number): Chain | null => {
    if (abbreviationAfter === null) {
      return null;
    }
    const first = parseElement(text, index, 0, []);
    if (first === null) {
      return null;
    }
    const elements = [first];
    let position = first.end;
    for (;;) {
      const joined = matchAt(connector, text, position);
      if (joined === null) {
        break;
      }
      const previous = elements.at(-1);
      if (previous === undefined) {
        break;
      }
      const next = parseNext(text, joined.index + joined[0].length, previous);
      if (next === null) {
        break;
      }
      elements.push(next);
      position = next.end;
    }
    while (elements.length > 0) {
      const last = elements.at(-1);
      if (last === undefined) {
        break;
      }
      const tail = matchAt(abbreviationAfter, text, last.end);
      const abbreviation = tail?.groups?.["abbreviation"];
      if (tail !== null && abbreviation !== undefined) {
        return { abbreviation, elements, end: tail.index + tail[0].length };
      }
      elements.pop();
    }
    return null;
  };

  const gazetteInput = new RegExp(`^(?:${gazette.source})$`, "iu");
  return {
    normalizeReference: (reference) => {
      if (reference.unit !== unit) {
        return null;
      }
      const values: (string | null)[] = [];
      for (const level of compiledLevels) {
        let value: string | null;
        switch (level.key) {
          case "section":
            value = `${String(reference.section)}${reference.sectionSuffix ?? ""}`;
            break;
          case "subsection":
            value = reference.subsection;
            break;
          case "letter":
            value = reference.letter;
            break;
          case "point":
            value = reference.point;
            break;
          default:
            level.key satisfies never;
            return panic("Unknown provision level");
        }
        if (value === null) {
          values.push(null);
          continue;
        }
        const match = matchAt(level.value, value, 0);
        if (match === null || match[0].length !== value.length) {
          return null;
        }
        values.push(valueOf(match));
      }
      const normalized = referenceOf(compiledLevels, values, unit);
      if (normalized === null) {
        return null;
      }
      return {
        ...normalized,
        sentence: reference.sentence,
        openEnded: reference.openEnded,
      };
    },
    unit,
    parseReference: (raw) => {
      // Validate designators before normalization can turn a non-ASCII letter into ASCII.
      const text = raw.trim();
      const element = parseElement(text, 0, 0, []);
      if (element === null || element.end !== text.length) {
        return null;
      }
      return referenceOf(compiledLevels, element.values, unit);
    },
    anchor,
    parseAnchor,
    gazette: {
      eli: gazette.eli,
      parse: (raw) => {
        const match = gazetteInput.exec(raw.trim());
        const number = match?.groups?.["number"];
        const year = match?.groups?.["year"];
        if (number === undefined || year === undefined) {
          return null;
        }
        const work = { number, year };
        return { identifier: gazette.identifier(work), eli: gazette.eli(work) };
      },
    },
    jurisdiction,
    locateAbbreviatedProvisions: (text) => {
      const citations: LocatedProvisionCitation[] = [];
      head.lastIndex = 0;
      for (
        let opener = head.exec(text);
        opener !== null;
        opener = head.exec(text)
      ) {
        const chain = parseChain(text, opener.index);
        if (chain === null) {
          continue;
        }
        head.lastIndex = chain.end;
        const abbreviation = resolveAbbreviation(chain.abbreviation);
        if (abbreviation === null) {
          continue;
        }
        for (const element of chain.elements) {
          const reference = referenceOf(compiledLevels, element.values, unit);
          if (reference === null) {
            continue;
          }
          citations.push({
            abbreviation,
            anchor: anchor(reference),
            end: element.end,
            jurisdiction,
            reference,
            start: element.start,
          });
        }
      }
      return citations;
    },
    locateGazetteCitations: (text) => {
      const citations: LocatedGazetteCitation[] = [];
      for (const match of text.matchAll(gazettePattern)) {
        const number = match.groups?.["number"];
        const year = match.groups?.["year"];
        if (number === undefined || year === undefined) {
          continue;
        }
        citations.push({
          eli: gazette.eli({ number, year }),
          end: match.index + match[0].length,
          jurisdiction,
          start: match.index,
        });
      }
      return citations;
    },
    status: "supported",
  };
};

const unsupported = <const TJurisdiction extends CaseLawJurisdiction>(
  jurisdiction: TJurisdiction,
) => ({ jurisdiction, status: "unsupported" as const });

/**
 * The public legislation corpus holds Czech acts only. A grammar for a
 * jurisdiction whose acts no reader can open would locate links that resolve
 * nowhere, so the other entries stay unsupported until their corpus lands.
 */
export const PROVISION_CITATION_GRAMMARS = {
  AUT: unsupported("AUT"),
  CZE: createProvisionCitationGrammar({
    abbreviations: [
      {
        canonicalAbbreviation: "s. ř. s.",
        eli: "https://www.e-sbirka.cz/eli/cz/sb/2002/150",
        patternSource: String.raw`s\s*\.?\s*ř\s*\.?\s*s\s*\.?(?![\p{L}\p{N}])`,
      },
    ],
    anchorSeparator: "-",
    connectors: [",", String.raw`a(?=\s)`, String.raw`ve\s+spojení\s+s(?=\s)`],
    gazette: {
      eli: ({ number, year }) =>
        `https://www.e-sbirka.cz/eli/cz/sb/${year}/${String(Number(number))}`,
      identifier: ({ number, year }) =>
        formatWorkIdentifier({
          number: Number(number),
          year: Number(year),
          collection: CZ_STATUTE_COLLECTION.canonical,
        }),
      // Reporters (`Sb. NSS`, `Sb. rozh.`) and the treaty collection
      // (`Sb. m. s.`) share the gazette's suffix and are not statutes.
      source: String.raw`(?<![\p{L}\p{N}])(?:č\.\s*)?(?<number>(?=\d{0,4}[1-9])\d{1,5})\/(?<year>[1-9]\d{3})\s+(?:${CZ_STATUTE_COLLECTION.spellings
        .toSorted((left, right) => right.length - left.length)
        .map((spelling) => RegExp.escape(spelling))
        .join(
          "|",
        )})(?![\p{L}\p{N}])(?!\.?\s*(?:m\.\s*s\.|${CZE_CASE_LAW_REPORTER_SUFFIX_SOURCE}))`,
    },
    jurisdiction: "CZE",
    levels: [
      {
        key: "section",
        marker: "§§?",
        value: String.raw`\d{1,4}[a-zA-Z]?`,
        anchorMarker: "par_",
      },
      {
        key: "subsection",
        anchorMarker: "odst_",
        marker: String.raw`odst\.`,
        value: String.raw`\d+[a-zA-Z]?`,
      },
      {
        key: "letter",
        anchorMarker: "pism_",
        marker: String.raw`p(?:í|i\u0301)sm\.`,
        value: String.raw`(?<value>[a-zA-Z])\)?`,
      },
      {
        key: "point",
        anchorMarker: "bod_",
        marker: String.raw`bod(?![\p{L}])`,
        value: String.raw`\d+`,
      },
    ],
    unit: "section",
  }),
  EU: unsupported("EU"),
  HUN: unsupported("HUN"),
  POL: unsupported("POL"),
  SVK: unsupported("SVK"),
  USA: unsupported("USA"),
} as const satisfies {
  readonly [
    TJurisdiction in CaseLawJurisdiction
  ]: ProvisionCitationGrammar<TJurisdiction>;
};

const SUPPORTED_GRAMMARS: SupportedProvisionCitationGrammar[] = [];
for (const grammar of Object.values(PROVISION_CITATION_GRAMMARS)) {
  if (grammar.status === "supported") {
    SUPPORTED_GRAMMARS.push(grammar);
  }
}

/**
 * A gazette names its own jurisdiction (`Sb.`, `Z. z.`, `Dz. U.`), so
 * work-level citations are read with every grammar whichever court cites
 * them. Abbreviations are the citing court's shorthand and are read with its
 * grammar alone.
 */
export const locateGazetteCitations = (
  text: string,
): LocatedGazetteCitation[] =>
  SUPPORTED_GRAMMARS.flatMap((grammar) => grammar.locateGazetteCitations(text));
