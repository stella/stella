import type { AppliedProvisionVersion } from "@stll/api-contract/provision-applied-version";
import type { ProvisionReference } from "@stll/legal-ast/provision-reference";
import { Temporal } from "@stll/time";

import { normalizeEuLegalIdentifier } from "./eu-legal-identity";

export const EU_PROVISION_CITATION_LANGUAGES = [
  "cs",
  "sk",
  "pl",
  "hu",
  "en",
  "de",
  "fr",
] as const;

const EU_ACT_KINDS = {
  directive: { celexLetter: "L", eliKind: "dir" },
  regulation: { celexLetter: "R", eliKind: "reg" },
} as const;

type EuActKind = keyof typeof EU_ACT_KINDS;

const ACT_NUMBER_ORDERS = {
  directive: {
    before2015: "year-number",
    from2015: "year-number",
  },
  regulation: {
    before2015: "number-year",
    from2015: "year-number",
  },
} as const satisfies Record<
  EuActKind,
  Record<"before2015" | "from2015", "number-year" | "year-number">
>;

export type EuActIdentity = {
  celex: string;
  eli: string;
} & (
  | { kind: EuActKind; number: number; year: number }
  | { kind: "teu" | "tfeu" | "charter"; number: null; year: null }
);

/** Series identifiers are stable work keys; a stated edition is separate evidence. */
export const EU_PRIMARY_WORKS = {
  teu: {
    kind: "teu",
    celex: "12016M/TXT",
    eli: "http://data.europa.eu/eli/treaty/teu_2016/oj",
    number: null,
    year: null,
  },
  tfeu: {
    kind: "tfeu",
    celex: "12016E/TXT",
    eli: "http://data.europa.eu/eli/treaty/tfeu_2016/oj",
    number: null,
    year: null,
  },
  charter: {
    kind: "charter",
    celex: "12016P/TXT",
    eli: "http://data.europa.eu/eli/treaty/char_2016/oj",
    number: null,
    year: null,
  },
} as const satisfies Record<string, EuActIdentity>;

export const parseEuWorkIdentifier = (raw: string): EuActIdentity | null => {
  const identifier = normalizeEuLegalIdentifier(raw);
  if (identifier === null) {
    return null;
  }
  const primary = Object.values(EU_PRIMARY_WORKS).find(
    ({ celex }) => celex === identifier,
  );
  if (primary !== undefined) {
    return primary;
  }
  const match = /^3(?<year>\d{4})(?<kind>[LR])(?<number>\d{4})$/u.exec(
    identifier,
  );
  const year = match?.groups?.["year"];
  const number = match?.groups?.["number"];
  if (
    year === undefined ||
    number === undefined ||
    Number(year) < 1950 ||
    Number(year) > Temporal.Now.plainDateISO("UTC").year ||
    Number(number) === 0
  ) {
    return null;
  }
  return actIdentity(
    match?.groups?.["kind"] === "L" ? "directive" : "regulation",
    Number(year),
    Number(number),
  );
};

export const euProvisionSourceUrl = (
  workIdentifier: string,
  reference?: ProvisionReference,
): string | null => {
  const work = parseEuWorkIdentifier(workIdentifier);
  if (work === null) {
    return null;
  }
  const anchor =
    reference === undefined
      ? ""
      : `#art_${String(reference.section)}${reference.sectionSuffix ?? ""}`;
  return `https://eur-lex.europa.eu/legal-content/AUTO/?uri=CELEX:${encodeURIComponent(work.celex)}${anchor}`;
};

export type LocatedEuProvisionCitation = {
  act: EuActIdentity;
  appliedVersion: AppliedProvisionVersion;
  source: "number" | "alias";
  end: number;
  jurisdiction: "EU";
  reference: ProvisionReference;
  start: number;
};

type EuActAlias = Extract<EuActIdentity, { kind: EuActKind }> & {
  patterns: readonly string[];
};

const actIdentity = (
  kind: EuActKind,
  year: number,
  number: number,
): Extract<EuActIdentity, { kind: EuActKind }> => {
  const { celexLetter, eliKind } = EU_ACT_KINDS[kind];
  return {
    celex: `3${String(year).padStart(4, "0")}${celexLetter}${String(number).padStart(4, "0")}`,
    eli: `http://data.europa.eu/eli/${eliKind}/${String(year)}/${String(number)}/oj`,
    kind,
    number,
    year,
  };
};

/** Closed aliases whose meaning is independent of the citing decision's language. */
export const EU_ACT_ALIASES = {
  gdpr: {
    ...actIdentity("regulation", 2016, 679),
    patterns: [
      String.raw`GDPR`,
      String.raw`RODO`,
      String.raw`obecn(?:é|e\u0301) nařízení o ochraně osobních údajů`,
    ],
  },
} as const satisfies Record<string, EuActAlias>;

type EuProvisionLabel = { example: string; pattern: string };

export const EU_PROVISION_ARTICLE_LABELS = [
  { example: "Article", pattern: "Article" },
  { example: "Art.", pattern: String.raw`Art\.?` },
  { example: "článek", pattern: "člán(?:ek|ok|ku|kem|kom)" },
  { example: "čl.", pattern: String.raw`čl\.?` },
  { example: "cikk", pattern: "cikk" },
  { example: "Artikel", pattern: "Artikel" },
] as const satisfies readonly EuProvisionLabel[];

export const EU_PROVISION_PARAGRAPH_LABELS = [
  { example: "odst.", pattern: String.raw`odst\.?` },
  { example: "ods.", pattern: String.raw`ods\.?` },
  { example: "ust.", pattern: String.raw`ust\.?` },
  { example: "bekezdés", pattern: String.raw`bekezd(?:és)?` },
  { example: "paragraphe", pattern: "paragraphe" },
  { example: "paragraph", pattern: "paragraph" },
  { example: "para", pattern: String.raw`para\.?` },
  { example: "Abs.", pattern: String.raw`Abs\.?` },
] as const satisfies readonly EuProvisionLabel[];

export const EU_PROVISION_POINT_LABELS = [
  { example: "písm.", pattern: String.raw`písm\.?` },
  { example: "pism.", pattern: String.raw`pism\.?` },
  { example: "lit.", pattern: String.raw`lit\.?` },
  { example: "point", pattern: "point" },
  { example: "lettre", pattern: "lettre" },
  { example: "Buchst.", pattern: String.raw`Buchst\.?` },
  { example: "pont", pattern: "pont" },
] as const satisfies readonly EuProvisionLabel[];

const labelSource = (labels: readonly EuProvisionLabel[]): string =>
  labels.map(({ pattern }) => pattern).join("|");

const ARTICLE = String.raw`(?<!\p{L})(?:${labelSource(EU_PROVISION_ARTICLE_LABELS)})\s*(?<article>\d+[a-zA-Z]?)`;
const PARAGRAPH = String.raw`(?:\s*(?:\((?<parenParagraph>\d+)\)|(?:${labelSource(EU_PROVISION_PARAGRAPH_LABELS)})\s*(?<wordParagraph>\d+)))?`;
const POINT = String.raw`(?:\s*(?:\((?<parenthesizedPoint>[a-z])\)|(?:(?:${labelSource(EU_PROVISION_POINT_LABELS)})\s*)?(?<point>[a-z])\)))?`;
// Both components are bounded by non-digits: a longer number is a different
// (or unsupported) instrument, never a truncated prefix of one.
const YEAR_NUMBER = String.raw`(?<!\d)(?<first>\d{1,4})\s*\/\s*(?<second>\d{1,4})(?!\d)`;
const ACT_KIND = {
  directive: String.raw`(?:Directive|směrnic(?:e|i)|smernic(?:a|e|i)|dyrektyw(?:a|y)|irányelv|Richtlinie|directive)`,
  regulation: String.raw`(?:Regulation|nařízen(?:í|i)|nariaden(?:ie|ia)|rozporządzeni(?:e|a)|rendelet|Verordnung|règlement)`,
} as const satisfies Record<EuActKind, string>;
const EU_MARKER_SOURCE = String.raw`(?:EU|EÚ|UE|EG|EC|ES|CE|WE|EK|EEC|EHS|EWG|EGK)(?![\p{L}\p{N}])`;
const EU_MARKER = String.raw`(?:\(${EU_MARKER_SOURCE}\)\s*)?`;

const compileActPattern = (kind: EuActKind): RegExp =>
  new RegExp(
    String.raw`${ARTICLE}${PARAGRAPH}${POINT}\s*(?:of\s+(?:the\s+)?|de\s+(?:la\s+)?|du\s+|der\s+|des\s+|nařízení\s+|nariadenia\s+|rozporządzenia\s+)?${ACT_KIND[kind]}\s*${EU_MARKER}(?<hasNumberFirst>(?:No\.?|Nr\.?|č\.?|c\.)\s*)?${YEAR_NUMBER}(?:\s*\/${EU_MARKER_SOURCE})?`,
    "giu",
  );

const HUNGARIAN_REFERENCE = String.raw`(?<article>\d+[a-zA-Z]?)\.\s*cikk(?:\s*\((?<parenParagraph>\d+)\)\s*bekezd(?:és)?)?(?:\s*(?<point>[a-z])\)\s*pont)?`;

const compileActPatterns = (kind: EuActKind) => [
  compileActPattern(kind),
  new RegExp(
    String.raw`${HUNGARIAN_REFERENCE}\s*${YEAR_NUMBER}\s*\/${EU_MARKER_SOURCE}\s*${ACT_KIND[kind]}`,
    "giu",
  ),
];

const ACT_PATTERNS = {
  directive: { kind: "directive", patterns: compileActPatterns("directive") },
  regulation: {
    kind: "regulation",
    patterns: compileActPatterns("regulation"),
  },
} as const satisfies {
  [Kind in EuActKind]: { kind: Kind; patterns: readonly RegExp[] };
};

const ALIAS_PATTERN = new RegExp(
  String.raw`${ARTICLE}${PARAGRAPH}${POINT}\s*(?:of\s+|de\s+|der\s+|des\s+)?(?<alias>${Object.values(
    EU_ACT_ALIASES,
  )
    .flatMap(({ patterns }) => patterns)
    .join("|")})(?![\p{L}\p{N}])`,
  "giu",
);

const PRIMARY_ALIASES = {
  teu: String.raw`(?:TEU|SEU|ZEÚ|EUV|EUSZ|TUE|Treaty on European Union|Smlouvy o Evropské unii|Zmluvy o Európskej únii|Traktatu o Unii Europejskiej|Vertrag(?:s)? über die Europäische Union|traité sur l’Union européenne)`,
  tfeu: String.raw`(?:TFEU|SFEU|ZFEÚ|AEUV|EUMSZ|TFUE|Treaty on the Functioning of the European Union|Smlouvy o fungování Evropské unie|Zmluvy o fungovaní Európskej únie|Traktatu o funkcjonowaniu Unii Europejskiej|Vertrag(?:s)? über die Arbeitsweise der Europäischen Union|traité sur le fonctionnement de l’Union européenne)`,
  charter: String.raw`(?:Charter of Fundamental Rights(?: of the European Union)?|Listiny základních práv Evropské unie|Charty základných práv Európskej únie|Karty praw podstawowych(?: Unii Europejskiej)?|Charta der Grundrechte(?: der Europäischen Union)?|Charte des droits fondamentaux(?: de l’Union européenne)?|Európai Unió Alapjogi Chartája|GRCh)`,
} as const satisfies Record<keyof typeof EU_PRIMARY_WORKS, string>;
const PRIMARY_PATTERNS = Object.values(EU_PRIMARY_WORKS).flatMap(({ kind }) => {
  const tail = String.raw`\s*(?:of\s+(?:the\s+)?|de\s+|du\s+|der\s+|des\s+)?${PRIMARY_ALIASES[kind]}(?![\p{L}\p{N}])(?:\s*\((?<edition>2008|2010|2012|2016)\))?`;
  return [
    [
      kind,
      new RegExp(String.raw`${ARTICLE}${PARAGRAPH}${POINT}${tail}`, "giu"),
    ] as const,
    [
      kind,
      new RegExp(String.raw`${HUNGARIAN_REFERENCE}${tail}`, "giu"),
    ] as const,
  ];
});
const REFERENCE_PATTERNS = [
  new RegExp(String.raw`^${ARTICLE}${PARAGRAPH}${POINT}\s*$`, "iu"),
  new RegExp(String.raw`^${HUNGARIAN_REFERENCE}\s*$`, "iu"),
];

export const parseEuProvisionReference = (
  raw: string,
): ProvisionReference | null => {
  for (const pattern of REFERENCE_PATTERNS) {
    const match = pattern.exec(raw);
    if (match !== null) {
      return referenceFrom(match.groups ?? {});
    }
  }
  return null;
};

const normalizeYear = (raw: string): number => {
  const year = Number(raw);
  if (raw.length === 4) {
    return year;
  }
  return year >= 50 ? 1900 + year : 2000 + year;
};

type NumberedActIdentityOptions = {
  kind: EuActKind;
  groups: Record<string, string | undefined>;
  maxYear: number;
};

const numberedActIdentity = ({
  kind,
  groups,
  maxYear,
}: NumberedActIdentityOptions): EuActIdentity | null => {
  const first = groups["first"];
  const second = groups["second"];
  if (first === undefined || second === undefined) {
    return null;
  }
  const explicitlyNumberFirst = groups["hasNumberFirst"] !== undefined;
  const candidates: EuActIdentity[] = [];
  for (const order of ["year-number", "number-year"] as const) {
    const rawYear = order === "year-number" ? first : second;
    const rawNumber = order === "year-number" ? second : first;
    const isUnambiguousLegacyNumberYear =
      order === "number-year" &&
      rawNumber.length === 4 &&
      rawYear.length === 2 &&
      normalizeYear(rawYear) < 1999;
    // Without an explicit number marker, a sole four-digit component is the year.
    // Legacy regulations also used NNNN/YY before 1999, which is unambiguous.
    // Do not rescue a future year by treating it as an older act's number.
    if (
      !explicitlyNumberFirst &&
      (first.length === 4) !== (second.length === 4) &&
      rawYear.length !== 4 &&
      !isUnambiguousLegacyNumberYear
    ) {
      continue;
    }
    if (rawYear.length !== 2 && rawYear.length !== 4) {
      continue;
    }
    const year = normalizeYear(rawYear);
    const number = Number(rawNumber);
    if (year < 1950 || year > maxYear || number < 1 || number > 9999) {
      continue;
    }
    const era = year >= 2015 ? "from2015" : "before2015";
    // Short years belong to legacy numbering; modern identifiers print four digits.
    if (era === "from2015" && rawYear.length !== 4) {
      continue;
    }
    const expectedOrder = explicitlyNumberFirst
      ? "number-year"
      : ACT_NUMBER_ORDERS[kind][era];
    if (order !== expectedOrder) {
      continue;
    }
    candidates.push(actIdentity(kind, year, number));
  }
  // Two plausible year/number readings are ambiguous, never a guessed identity.
  return candidates.length === 1 ? (candidates.at(0) ?? null) : null;
};

const referenceFrom = (groups: Record<string, string | undefined>) => {
  const rawSection = groups["article"];
  if (rawSection === undefined) {
    return null;
  }
  const matched = /^(?<number>\d+)(?<suffix>[a-zA-Z]?)$/u.exec(rawSection);
  const number = matched?.groups?.["number"];
  if (number === undefined || Number(number) < 1) {
    return null;
  }
  return {
    letter:
      groups["parenthesizedPoint"]?.toLowerCase() ??
      groups["point"]?.toLowerCase() ??
      null,
    openEnded: false,
    point: null,
    section: Number(number),
    sectionSuffix: matched?.groups?.["suffix"]?.toLowerCase() || null,
    sentence: null,
    subsection: groups["parenParagraph"] ?? groups["wordParagraph"] ?? null,
    unit: "article" as const,
  } satisfies ProvisionReference;
};

const aliasMatchers = Object.values(EU_ACT_ALIASES).map((alias) => ({
  alias,
  pattern: new RegExp(`^(?:${alias.patterns.join("|")})$`, "iu"),
}));

const locatePrimaryEuProvisionCitations = (
  text: string,
  maxYear: number,
): LocatedEuProvisionCitation[] => {
  const citations: LocatedEuProvisionCitation[] = [];
  for (const [kind, pattern] of PRIMARY_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const reference = referenceFrom(match.groups ?? {});
      if (reference === null) {
        continue;
      }
      const edition = match.groups?.["edition"];
      if (edition !== undefined && Number(edition) > maxYear) {
        continue;
      }
      const letter = { teu: "M", tfeu: "E", charter: "P" } as const;
      citations.push({
        act: EU_PRIMARY_WORKS[kind],
        source: "alias",
        appliedVersion:
          edition === undefined
            ? { type: "not_stated" }
            : {
                type: "stated_version",
                amendmentWorkIdentifier: `1${edition}${letter[kind]}/TXT`,
                evidence: {
                  start: match.index,
                  end: match.index + match[0].length,
                  kind: "stated_version",
                },
              },
        reference,
        jurisdiction: "EU",
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  return citations;
};

type LocateEuProvisionCitationsOptions = {
  /** ISO decision date; an unknown date admits no future secondary-law year. */
  citedOn?: string | null;
};

/** Locate EU provision references without requiring hosted act text. */
export const locateEuProvisionCitations = (
  text: string,
  { citedOn }: LocateEuProvisionCitationsOptions = {},
): LocatedEuProvisionCitation[] => {
  const currentYear = Temporal.Now.plainDateISO("UTC").year;
  const maxYear =
    citedOn === null || citedOn === undefined
      ? currentYear
      : Math.min(currentYear, Number(citedOn.slice(0, 4)));
  if (!Number.isInteger(maxYear) || maxYear < 1950) {
    return [];
  }
  const citations: LocatedEuProvisionCitation[] = [];
  for (const { kind, patterns } of Object.values(ACT_PATTERNS)) {
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const act = numberedActIdentity({
          kind,
          groups: match.groups ?? {},
          maxYear,
        });
        const reference = referenceFrom(match.groups ?? {});
        if (act === null || reference === null) {
          continue;
        }
        citations.push({
          act,
          source: "number",
          appliedVersion: { type: "not_stated" },
          end: match.index + match[0].length,
          jurisdiction: "EU",
          reference,
          start: match.index,
        });
      }
    }
  }
  ALIAS_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(ALIAS_PATTERN)) {
    const printed = match.groups?.["alias"];
    const matches =
      printed === undefined
        ? []
        : aliasMatchers.filter(({ pattern }) => pattern.test(printed));
    const alias = matches.length === 1 ? matches.at(0)?.alias : undefined;
    const reference = referenceFrom(match.groups ?? {});
    if (alias === undefined || alias.year > maxYear || reference === null) {
      continue;
    }
    citations.push({
      source: "alias",
      appliedVersion: { type: "not_stated" },
      act: {
        celex: alias.celex,
        eli: alias.eli,
        kind: alias.kind,
        number: alias.number,
        year: alias.year,
      },
      end: match.index + match[0].length,
      jurisdiction: "EU",
      reference,
      start: match.index,
    });
  }
  citations.push(...locatePrimaryEuProvisionCitations(text, maxYear));
  return citations.toSorted((left, right) => left.start - right.start);
};

export const EU_PROVISION_ANCHOR_SEPARATOR = "-";

/** Stable citation identity; publisher links deliberately stop at the article. */
export const euProvisionAnchor = (reference: ProvisionReference): string => {
  const parts = [
    `art_${String(reference.section)}${reference.sectionSuffix ?? ""}`,
  ];
  if (reference.subsection !== null) {
    parts.push(`par_${reference.subsection}`);
  }
  if (reference.letter !== null) {
    parts.push(`pt_${reference.letter}`);
  }
  if (reference.point !== null) {
    parts.push(`num_${reference.point}`);
  }
  return parts.join(EU_PROVISION_ANCHOR_SEPARATOR);
};

export const parseEuProvisionAnchor = (
  raw: string,
): ProvisionReference | null => {
  const match =
    /^art_(?<article>[1-9]\d*[a-z]?)(?:-par_(?<wordParagraph>[1-9]\d*))?(?:-pt_(?<point>[a-z]))?(?:-num_(?<numericPoint>[1-9]\d*))?$/u.exec(
      raw,
    );
  if (match?.groups === undefined) {
    return null;
  }
  const reference = referenceFrom(match.groups);
  return reference === null
    ? null
    : { ...reference, point: match.groups["numericPoint"] ?? null };
};

export const normalizeEuProvisionReference = (
  reference: ProvisionReference,
): ProvisionReference | null => {
  if (
    reference.unit !== "article" ||
    !Number.isSafeInteger(reference.section) ||
    reference.section < 1
  ) {
    return null;
  }
  const canonical = (value: string | null) =>
    value === null ? null : value.toLowerCase().replace(/^0+(?=\d)/u, "");
  const normalized = {
    ...reference,
    sectionSuffix: canonical(reference.sectionSuffix),
    subsection: canonical(reference.subsection),
    letter: canonical(reference.letter),
    point: canonical(reference.point),
  };
  return parseEuProvisionAnchor(euProvisionAnchor(normalized)) === null
    ? null
    : normalized;
};
