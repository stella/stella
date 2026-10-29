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

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { isCaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import { CZE_CASE_LAW_REPORTER_SUFFIX_SOURCE } from "@stll/api-contract/statute-gazette";
import type {
  ProvisionReference,
  ProvisionUnit,
} from "@stll/legal-ast/provision-reference";
import { normalizeUnicode } from "@stll/text-normalize";

import { CZ_STATUTE_COLLECTION } from "./cz-provision-citation-profile";
import {
  EU_PROVISION_ANCHOR_SEPARATOR,
  euProvisionAnchor,
  locateEuProvisionCitations,
  normalizeEuProvisionReference,
  parseEuProvisionAnchor,
  parseEuProvisionReference,
  parseEuWorkIdentifier,
} from "./eu-provision-citations";
import { formatWorkIdentifier } from "./provision-citation-profile";
import type {
  JurisdictionProfile,
  SectionUnit,
  WorkIdentifier,
} from "./provision-citation-profile";
import { provisionCitationProfileFor } from "./provision-citation-profiles";
import { SK_PROFILE } from "./sk-provision-citation-profile";
import {
  formatUsCodeReference,
  locateUsCodeCitations,
  normalizeUsCodeReference,
  parseUsCodeAnchor,
  parseUsCodeReference,
  parseUsCodeWorkIdentifier,
  US_CODE_ANCHOR_SEPARATOR,
  usCodeAnchor,
  usCodeReference,
  usCodeWorkEli,
  usCodeWorkIdentifier,
} from "./us-code-citations";
import type { UsCodeWork } from "./us-code-citations";

/** The one work a printed citation names (`42 U.S.C. § 1983`), or null. */
const onlyCitedWork = (raw: string): UsCodeWork | null => {
  const text = raw.trim();
  const [only, ...others] = locateUsCodeCitations(text);
  return only === undefined ||
    others.length > 0 ||
    only.start !== 0 ||
    only.end !== text.length
    ? null
    : only.work;
};

export type StatuteAbbreviationEntry = {
  canonicalAbbreviation: string;
  eli: string;
  /** RegExp source accepting exactly this jurisdiction's printed variants. */
  patternSource: string;
  /** Profile aliases retain their case-sensitive spelling. */
  caseSensitive?: boolean;
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

type GazetteWork = {
  number: string;
  year: string;
  /** A grammar that reads several collections captures their printed spelling. */
  collection?: string | undefined;
};

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
  /**
   * Joins the levels of an anchor this grammar mints: every prefix of an
   * anchor that ends before one names the enclosing provision.
   */
  anchorSeparator: string;
  parseAnchor: (raw: string) => ProvisionReference | null;
  unit: ProvisionUnit;
  gazette: {
    parse: (raw: string) => { identifier: string; eli: string } | null;
  };
  jurisdiction: TJurisdiction;
  locateAbbreviatedProvisions: (text: string) => LocatedProvisionCitation[];
  locateGazetteCitations: (text: string) => LocatedGazetteCitation[];
  parseReference: (raw: string) => ProvisionReference | null;
  normalizeReference: (
    reference: ProvisionReference,
  ) => ProvisionReference | null;
  /** Where this grammar's references can be opened. */
  target: "hosted" | "publisher";
  /**
   * How a reference reads back to a lawyer. `catalog`: the section sign or
   * article word, then each subdivision named in the reader's language
   * (`§ 46 para. 1 lit. a)`). `printed`: the jurisdiction prints its
   * citations in one form whatever the reader's language (`§ 1983(a)(1)`),
   * and the grammar renders it.
   */
  citationForm:
    | { type: "catalog" }
    | { type: "printed"; format: (reference: ProvisionReference) => string };
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
        // A statute numbers its sections from 1; the shared schema admits 0
        // only for the codes that use it.
        if (reference.section < 1) {
          return null;
        }
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
}: ProvisionCitationGrammarSpec<TJurisdiction>): SupportedProvisionCitationGrammar<TJurisdiction> & {
  gazette: { eli: (work: GazetteWork) => string };
} => {
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
    matcher: new RegExp(
      `^(?:${entry.patternSource})$`,
      entry.caseSensitive === true ? "u" : "iu",
    ),
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
      if (reference.unit !== unit || reference.section < 1) {
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
    anchorSeparator,
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
        const work = {
          number,
          year,
          collection: match?.groups?.["collection"],
        };
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
          eli: gazette.eli({
            number,
            year,
            collection: match.groups?.["collection"],
          }),
          end: match.index + match[0].length,
          jurisdiction,
          start: match.index,
        });
      }
      return citations;
    },
    status: "supported",
    target: "hosted",
    citationForm: { type: "catalog" },
  };
};

/**
 * Pattern for a printed spelling whose spaces admit any whitespace run, or
 * none after a period ("Z. z." also reads "Z.z." and "Z.&nbsp;z."). Split
 * before escaping: `RegExp.escape` encodes spaces as `\x20`.
 */
const spacedSpellingSource = (spelling: string): string => {
  const words = spelling.split(/\s+/u);
  return words
    .map((word, index) => {
      let gap = "";
      if (index > 0) {
        gap =
          words.at(index - 1)?.endsWith(".") === true
            ? String.raw`\s*`
            : String.raw`\s+`;
      }
      return `${gap}${RegExp.escape(word)}`;
    })
    .join("");
};

/** A date-free reader links only aliases that never name another act. */
const profileAbbreviations = (
  profile: JurisdictionProfile,
  eliForWork: (work: WorkIdentifier) => string,
) => {
  const bySpelling = new Map<
    string,
    { spelling: string; works: Map<string, string>; units: Set<SectionUnit> }
  >();
  for (const entry of profile.aliases) {
    for (const spelling of entry.spellings) {
      const key = spelling.toLowerCase().replace(/\.\s+/gu, ".");
      let group = bySpelling.get(key);
      if (group === undefined) {
        group = { spelling, works: new Map(), units: new Set() };
        bySpelling.set(key, group);
      }
      group.units.add(entry.unit ?? "section");
      group.works.set(
        formatWorkIdentifier(entry.identifier),
        eliForWork(entry.identifier),
      );
    }
  }
  return [...bySpelling.values()].flatMap(({ spelling, works, units }) => {
    if (units.size !== 1 || !units.has("section")) {
      return [];
    }
    const eli = works.size === 1 ? works.values().next().value : undefined;
    if (eli === undefined) {
      return [];
    }
    return [
      {
        canonicalAbbreviation: spelling,
        eli,
        patternSource: `${spacedSpellingSource(spelling)}(?![\\p{L}\\p{N}])`,
        caseSensitive: true,
      },
    ];
  });
};

const slovakWorkEli = ({ number, year }: GazetteWork) =>
  `https://www.slov-lex.sk/eli/sk/zz/${year}/${String(parseIntegerToken(number, { sign: "unsigned" }).unwrap("Gazette numbers contain only bounded decimal digits"))}`;

const slovakCollection = (printed: string | undefined) => {
  const key = printed?.replace(/\s+/gu, "").toLowerCase();
  return (
    SK_PROFILE.collections.find(({ spellings }) =>
      spellings.some(
        (spelling) => spelling.replace(/\s+/gu, "").toLowerCase() === key,
      ),
    )?.canonical ?? panic("Slovak gazette match has no declared collection")
  );
};

const unsupported = <const TJurisdiction extends CaseLawJurisdiction>(
  jurisdiction: TJurisdiction,
) => ({ jurisdiction, status: "unsupported" as const });

/**
 * Czech acts open in the hosted corpus; EU works open at their publisher.
 * Other jurisdictions remain unsupported until they have a target reader.
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
  EU: {
    jurisdiction: "EU",
    status: "supported",
    target: "publisher",
    citationForm: { type: "catalog" },
    unit: "article",
    anchor: euProvisionAnchor,
    anchorSeparator: EU_PROVISION_ANCHOR_SEPARATOR,
    parseAnchor: parseEuProvisionAnchor,
    normalizeReference: normalizeEuProvisionReference,
    parseReference: parseEuProvisionReference,
    locateGazetteCitations: () => [],
    gazette: {
      parse: (raw: string) => {
        const work = parseEuWorkIdentifier(raw);
        return work === null ? null : { identifier: work.celex, eli: work.eli };
      },
    },
    locateAbbreviatedProvisions: (text: string) =>
      locateEuProvisionCitations(text).map(
        ({ act, reference, start, end }) => ({
          abbreviation: { canonicalAbbreviation: act.celex, eli: act.eli },
          jurisdiction: "EU" as const,
          reference,
          start,
          end,
          anchor: euProvisionAnchor(reference),
        }),
      ),
  },
  GBR: unsupported("GBR"),
  HUN: unsupported("HUN"),
  POL: unsupported("POL"),
  SVK: createProvisionCitationGrammar({
    abbreviations: profileAbbreviations(SK_PROFILE, ({ number, year }) =>
      slovakWorkEli({ number: String(number), year: String(year) }),
    ),
    anchorSeparator: SK_PROFILE.anchor.join,
    connectors: [
      ",",
      ...SK_PROFILE.enumerationConnectors.map(
        (word) => `${RegExp.escape(word)}(?=\\s)`,
      ),
      String.raw`v\s+spojení\s+s(?=\s)`,
    ],
    gazette: {
      eli: slovakWorkEli,
      identifier: ({ number, year, collection }) =>
        formatWorkIdentifier({
          number: parseIntegerToken(number, { sign: "unsigned" }).unwrap(
            "Gazette numbers contain only bounded decimal digits",
          ),
          year: parseIntegerToken(year, { sign: "unsigned" }).unwrap(
            "Gazette years contain four decimal digits",
          ),
          collection: slovakCollection(collection),
        }),
      source: String.raw`(?<![\p{L}\p{N}])(?:č\.\s*)?(?<number>(?=\d{0,4}[1-9])\d{1,5})\/(?<year>[1-9]\d{3})\s+(?<collection>${SK_PROFILE.collections
        .flatMap(({ spellings }) => spellings)
        .toSorted((left, right) => right.length - left.length)
        .map(spacedSpellingSource)
        .join("|")})(?![\p{L}\p{N}/]|\.+[\p{L}\p{N}/])`,
    },
    jurisdiction: SK_PROFILE.jurisdiction,
    levels: [
      {
        key: "section",
        marker: `(?:${RegExp.escape(SK_PROFILE.citationTerms.section)}){1,2}`,
        value: String.raw`\d{1,4}[a-zA-Z]?`,
        anchorMarker: SK_PROFILE.anchor.render.section(""),
      },
      {
        key: "subsection",
        marker: RegExp.escape(SK_PROFILE.citationTerms.subsection),
        value: String.raw`\d+[a-zA-Z]?`,
        anchorMarker: SK_PROFILE.anchor.render.subsection(""),
      },
      {
        key: "letter",
        marker: `(?:${RegExp.escape(SK_PROFILE.citationTerms.letter)}|${RegExp.escape(normalizeUnicode(SK_PROFILE.citationTerms.letter, "NFD"))})`,
        value: String.raw`(?<value>[a-zA-Z])\)?`,
        anchorMarker: SK_PROFILE.anchor.render.letter(""),
      },
      {
        key: "point",
        marker: `${RegExp.escape(SK_PROFILE.citationTerms.point)}(?![\\p{L}])`,
        value: String.raw`\d+`,
        anchorMarker: SK_PROFILE.anchor.render.point(""),
      },
    ],
    unit: "section",
  }),
  USA: {
    jurisdiction: "USA",
    status: "supported",
    target: "hosted",
    citationForm: { type: "printed", format: formatUsCodeReference },
    unit: "section",
    anchor: usCodeAnchor,
    anchorSeparator: US_CODE_ANCHOR_SEPARATOR,
    parseAnchor: parseUsCodeAnchor,
    normalizeReference: normalizeUsCodeReference,
    parseReference: parseUsCodeReference,
    // A US citation names its section and its work in one span, so the
    // work-level reading would only repeat the provision: the provision
    // carries the work's ELI.
    locateGazetteCitations: () => [],
    gazette: {
      parse: (raw: string) => {
        const work = parseUsCodeWorkIdentifier(raw) ?? onlyCitedWork(raw);
        return work === null
          ? null
          : {
              identifier: usCodeWorkIdentifier(work),
              eli: usCodeWorkEli(work),
            };
      },
    },
    locateAbbreviatedProvisions: (text: string) =>
      locateUsCodeCitations(text).flatMap((citation) => {
        const reference = usCodeReference(citation);
        return reference === null
          ? []
          : [
              {
                abbreviation: {
                  canonicalAbbreviation: usCodeWorkIdentifier(citation.work),
                  eli: usCodeWorkEli(citation.work),
                },
                anchor: usCodeAnchor(reference),
                end: citation.end,
                jurisdiction: "USA" as const,
                reference,
                start: citation.start,
              },
            ];
      }),
  },
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

/**
 * The separator a jurisdiction's provision anchors are cut on: its
 * grammar's where it has one, its citation profile's where only the profile
 * mints anchors (Slovakia's `paragraf-5.odsek-1` joins on `.`), and null for
 * a jurisdiction that mints none, whose anchors are read whole.
 */
export const provisionAnchorSeparatorFor = (
  jurisdiction: string,
): string | null => {
  if (isCaseLawJurisdiction(jurisdiction)) {
    const grammar = PROVISION_CITATION_GRAMMARS[jurisdiction];
    if (grammar.status === "supported") {
      return grammar.anchorSeparator;
    }
  }
  return provisionCitationProfileFor(jurisdiction)?.anchor.join ?? null;
};

/**
 * How a jurisdiction's provision references read back to a lawyer: the
 * catalog's localized subdivision words unless its grammar prints its own
 * form.
 */
export const provisionCitationFormFor = (
  jurisdiction: string,
): SupportedProvisionCitationGrammar["citationForm"] => {
  if (isCaseLawJurisdiction(jurisdiction)) {
    const grammar = PROVISION_CITATION_GRAMMARS[jurisdiction];
    if (grammar.status === "supported") {
      return grammar.citationForm;
    }
  }
  return { type: "catalog" };
};
