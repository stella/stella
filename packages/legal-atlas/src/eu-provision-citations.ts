import type { ProvisionReference } from "@stll/legal-ast/provision-reference";

const EU_ACT_KINDS = {
  directive: { celexLetter: "L", eliKind: "dir" },
  regulation: { celexLetter: "R", eliKind: "reg" },
} as const;

type EuActKind = keyof typeof EU_ACT_KINDS;

export type EuActIdentity = {
  celex: string;
  eli: string;
  kind: EuActKind;
  number: number;
  year: number;
};

export type LocatedEuProvisionCitation = {
  act: EuActIdentity;
  end: number;
  jurisdiction: "EU";
  reference: ProvisionReference;
  start: number;
};

type EuActAlias = EuActIdentity & {
  patterns: readonly string[];
};

const actIdentity = (
  kind: EuActKind,
  year: number,
  number: number,
): EuActIdentity => {
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

const ARTICLE = String.raw`(?:Article|Art\.?|čl\.?|cikk|Artikel)\s*(?<article>\d+[a-zA-Z]?)`;
const PARAGRAPH = String.raw`(?:\s*(?:\((?<parenParagraph>\d+)\)|(?:odst\.?|ods\.?|ust\.?|bekezd(?:és)?|paragraphe|paragraph|para\.?|Abs\.?)\s*(?<wordParagraph>\d+)))?`;
const POINT = String.raw`(?:\s*(?:\((?<parenthesizedPoint>[a-z])\)|(?:(?:písm\.?|pism\.?|lit\.?|point|lettre|Buchst\.?|pont)\s*)?(?<point>[a-z])\)))?`;
const ACT_NUMBER = String.raw`(?<year>\d{2,4})\s*\/\s*(?<number>\d{1,4})`;
const ACT_KIND = {
  directive: String.raw`(?:Directive|směrnic(?:e|i)|smernic(?:a|e|i)|dyrektyw(?:a|y)|irányelv|Richtlinie|directive)`,
  regulation: String.raw`(?:Regulation|nařízen(?:í|i)|nariaden(?:ie|ia)|rozporządzeni(?:e|a)|rendelet|Verordnung|règlement)`,
} as const satisfies Record<EuActKind, string>;
const EU_MARKER = String.raw`(?:\((?:EU|EÚ|UE|EG|EC|EHS|EWG)\)\s*)?`;

const compileActPattern = (kind: EuActKind): RegExp =>
  new RegExp(
    String.raw`${ARTICLE}${PARAGRAPH}${POINT}\s*(?:of\s+|de\s+|du\s+|der\s+|des\s+|nařízení\s+|nariadenia\s+|rozporządzenia\s+)?${ACT_KIND[kind]}(?:\s+(?:No\.?|č\.?))?\s*${EU_MARKER}${ACT_NUMBER}(?:\s*\/(?:EU|EÚ|UE|EC|EG|EHS|EWG))?`,
    "giu",
  );

const ACT_PATTERNS = {
  directive: compileActPattern("directive"),
  regulation: compileActPattern("regulation"),
} as const satisfies Record<EuActKind, RegExp>;

const HUNGARIAN_REGULATION_PATTERN = new RegExp(
  String.raw`(?<article>\d+[a-zA-Z]?)\.\s*cikk(?:\s*\((?<parenParagraph>\d+)\)\s*bekezd(?:és)?)?(?:\s*(?<point>[a-z])\)\s*pont)?\s*${ACT_NUMBER}\s*\/(?:EU|EÚ)\s*${ACT_KIND.regulation}`,
  "giu",
);

const ALIAS_PATTERN = new RegExp(
  String.raw`${ARTICLE}${PARAGRAPH}${POINT}\s*(?:of\s+|de\s+|der\s+|des\s+)?(?<alias>${Object.values(
    EU_ACT_ALIASES,
  )
    .flatMap(({ patterns }) => patterns)
    .join("|")})(?![\p{L}\p{N}])`,
  "giu",
);

const normalizeYear = (raw: string): number => {
  const year = Number(raw);
  if (raw.length === 4) {
    return year;
  }
  return year >= 50 ? 1900 + year : 2000 + year;
};

const referenceFrom = (groups: Record<string, string | undefined>) => {
  const rawSection = groups["article"];
  if (rawSection === undefined) {
    return null;
  }
  const matched = /^(?<number>\d+)(?<suffix>[a-zA-Z]?)$/u.exec(rawSection);
  const number = matched?.groups?.["number"];
  if (number === undefined) {
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

/** Locate EU secondary-law provision references without requiring hosted act text. */
export const locateEuProvisionCitations = (
  text: string,
): LocatedEuProvisionCitation[] => {
  const citations: LocatedEuProvisionCitation[] = [];
  for (const kind of ["directive", "regulation"] as const) {
    const pattern = ACT_PATTERNS[kind];
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const year = match.groups?.["year"];
      const number = match.groups?.["number"];
      const reference = referenceFrom(match.groups ?? {});
      if (year === undefined || number === undefined || reference === null) {
        continue;
      }
      citations.push({
        act: actIdentity(kind, normalizeYear(year), Number(number)),
        end: match.index + match[0].length,
        jurisdiction: "EU",
        reference,
        start: match.index,
      });
    }
  }
  HUNGARIAN_REGULATION_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(HUNGARIAN_REGULATION_PATTERN)) {
    const year = match.groups?.["year"];
    const number = match.groups?.["number"];
    const reference = referenceFrom(match.groups ?? {});
    if (year === undefined || number === undefined || reference === null) {
      continue;
    }
    citations.push({
      act: actIdentity("regulation", normalizeYear(year), Number(number)),
      end: match.index + match[0].length,
      jurisdiction: "EU",
      reference,
      start: match.index,
    });
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
    if (alias === undefined || reference === null) {
      continue;
    }
    citations.push({
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
  return citations.toSorted((left, right) => left.start - right.start);
};
