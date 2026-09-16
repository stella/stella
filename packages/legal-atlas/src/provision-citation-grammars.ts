/**
 * How each jurisdiction prints a statute citation, and where it links.
 *
 * Section syntax, the abbreviations a court uses for its own acts, the
 * gazette a work is cited by, and the anchor ids its statute AST carries are
 * all jurisdiction-bound. The map is therefore total over the corpus
 * jurisdictions: a decision whose jurisdiction has no grammar reads its
 * citations as text, and onboarding one is an entry here, never another
 * country's typography applied by default.
 */
import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import type {
  ProvisionReference,
  ProvisionUnit,
} from "@stll/legal-ast/provision-reference";

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

type ProvisionCitationGrammarSpec<TJurisdiction extends CaseLawJurisdiction> = {
  /** Abbreviations courts of this jurisdiction use for its own acts. */
  abbreviations: readonly StatuteAbbreviationEntry[];
  /** Anchor id in this jurisdiction's statute AST for a parsed reference. */
  anchor: (reference: ProvisionReference) => string;
  /** RegExp sources that join provisions in one chain (`,`, `a`, `and`). */
  connectors: readonly string[];
  gazette: {
    eli: (work: GazetteWork) => string;
    /** RegExp source with `number` and `year` groups, no flags. */
    source: string;
  };
  jurisdiction: TJurisdiction;
  /**
   * RegExp source for one provision with the named groups `section`
   * (required), `sectionSuffix`, `subsection`, `letter`, and `point`. It is
   * compiled alone to parse and, with its groups stripped, inside the chain
   * pattern, so it carries no anchors or flags.
   */
  provisionSource: string;
  unit: ProvisionUnit;
};

export type SupportedProvisionCitationGrammar<
  TJurisdiction extends CaseLawJurisdiction = CaseLawJurisdiction,
> = {
  jurisdiction: TJurisdiction;
  locateAbbreviatedProvisions: (text: string) => LocatedProvisionCitation[];
  locateGazetteCitations: (text: string) => LocatedGazetteCitation[];
  status: "supported";
};

export type ProvisionCitationGrammar<
  TJurisdiction extends CaseLawJurisdiction = CaseLawJurisdiction,
> =
  | SupportedProvisionCitationGrammar<TJurisdiction>
  | { jurisdiction: TJurisdiction; status: "unsupported" };

const NAMED_GROUP = /\(\?<[A-Za-z]+>/gu;

const parseReference = (
  groups: Record<string, string | undefined> | undefined,
  unit: ProvisionUnit,
): ProvisionReference | null => {
  const section = groups?.["section"];
  if (groups === undefined || section === undefined) {
    return null;
  }
  const sectionSuffix = groups["sectionSuffix"];
  return {
    letter: groups["letter"]?.toLowerCase() ?? null,
    openEnded: false,
    point: groups["point"] ?? null,
    section: Number.parseInt(section, 10),
    sectionSuffix:
      sectionSuffix === undefined || sectionSuffix.length === 0
        ? null
        : sectionSuffix.toLowerCase(),
    sentence: null,
    subsection: groups["subsection"]?.toLowerCase() ?? null,
    unit,
  };
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
  anchor,
  connectors,
  gazette,
  jurisdiction,
  provisionSource,
  unit,
}: ProvisionCitationGrammarSpec<TJurisdiction>): SupportedProvisionCitationGrammar<TJurisdiction> => {
  const provision = new RegExp(provisionSource, "giu");
  const bareProvision = provisionSource.replaceAll(NAMED_GROUP, "(?:");
  const abbreviationSource = abbreviations
    .map(({ patternSource }) => `(?:${patternSource})`)
    .join("|");
  const chain =
    abbreviations.length === 0
      ? null
      : new RegExp(
          `${bareProvision}(?:\\s*(?:${connectors.join("|")})\\s*${bareProvision})*\\s+(?<abbreviation>${abbreviationSource})`,
          "giu",
        );
  const matchers = abbreviations.map((entry) => ({
    entry,
    matcher: new RegExp(`^(?:${entry.patternSource})$`, "iu"),
  }));
  const gazettePattern = new RegExp(gazette.source, "giu");

  const resolveAbbreviation = (printed: string): StatuteAbbreviation | null => {
    const normalized = printed.normalize("NFC");
    const matched = matchers.filter(({ matcher }) => matcher.test(normalized));
    const only = matched.length === 1 ? matched.at(0) : undefined;
    return only === undefined
      ? null
      : {
          canonicalAbbreviation: only.entry.canonicalAbbreviation,
          eli: only.entry.eli,
        };
  };

  return {
    jurisdiction,
    locateAbbreviatedProvisions: (text) => {
      if (chain === null) {
        return [];
      }
      const citations: LocatedProvisionCitation[] = [];
      for (const match of text.matchAll(chain)) {
        const printed = match.groups?.["abbreviation"];
        if (printed === undefined) {
          continue;
        }
        const abbreviation = resolveAbbreviation(printed);
        if (abbreviation === null) {
          continue;
        }
        const provisionsText = match[0].slice(0, -printed.length);
        for (const found of provisionsText.matchAll(provision)) {
          const reference = parseReference(found.groups, unit);
          if (reference === null) {
            continue;
          }
          const start = match.index + found.index;
          citations.push({
            abbreviation,
            anchor: anchor(reference),
            end: start + found[0].length,
            jurisdiction,
            reference,
            start,
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

const czechProvisionAnchor = (reference: ProvisionReference): string =>
  [
    `par_${String(reference.section)}${reference.sectionSuffix ?? ""}`,
    ...(reference.subsection === null ? [] : [`odst_${reference.subsection}`]),
    ...(reference.letter === null ? [] : [`pism_${reference.letter}`]),
    ...(reference.point === null ? [] : [`bod_${reference.point}`]),
  ].join("-");

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
    anchor: czechProvisionAnchor,
    connectors: [",", "a", String.raw`ve\s+spojení\s+s`],
    gazette: {
      eli: ({ number, year }) =>
        `https://www.e-sbirka.cz/eli/cz/sb/${year}/${number}`,
      // Reporters (`Sb. NSS`, `Sb. rozh.`) and the treaty collection
      // (`Sb. m. s.`) share the gazette's suffix and are not statutes.
      source: String.raw`(?<![\p{L}\p{N}])(?:č\.\s*)?(?<number>\d{1,5})\/(?<year>\d{4})\s+Sb\.(?!\s*(?:m\.\s*s\.|NSS|rozh\.))`,
    },
    jurisdiction: "CZE",
    provisionSource: String.raw`§\s*(?<section>\d{1,4})(?<sectionSuffix>[a-z]?)(?:\s+odst\.\s*(?<subsection>\d+[a-z]?))?(?:\s+písm\.\s*(?<letter>[a-z])\)?)?`,
    unit: "section",
  }),
  EU: unsupported("EU"),
  POL: unsupported("POL"),
  SVK: unsupported("SVK"),
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
