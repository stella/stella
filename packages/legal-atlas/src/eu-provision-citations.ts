import type { ProvisionReference } from "@stll/legal-ast/provision-reference";

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
const YEAR_NUMBER = String.raw`(?<first>\d{1,4})\s*\/\s*(?<second>\d{1,4})`;
const ACT_KIND = {
  directive: String.raw`(?:Directive|směrnic(?:e|i)|smernic(?:a|e|i)|dyrektyw(?:a|y)|irányelv|Richtlinie|directive)`,
  regulation: String.raw`(?:Regulation|nařízen(?:í|i)|nariaden(?:ie|ia)|rozporządzeni(?:e|a)|rendelet|Verordnung|règlement)`,
} as const satisfies Record<EuActKind, string>;
const EU_MARKER = String.raw`(?:\((?:EU|EÚ|UE|EG|EC|EHS|EWG)\)\s*)?`;

const compileActPattern = (kind: EuActKind): RegExp =>
  new RegExp(
    String.raw`${ARTICLE}${PARAGRAPH}${POINT}\s*(?:of\s+|de\s+|du\s+|der\s+|des\s+|nařízení\s+|nariadenia\s+|rozporządzenia\s+)?${ACT_KIND[kind]}\s*${EU_MARKER}(?<hasNumberFirst>(?:No\.?|Nr\.?|č\.?|c\.)\s*)?${YEAR_NUMBER}(?:\s*\/(?:EU|EÚ|UE|EC|EG|EHS|EWG))?`,
    "giu",
  );

const ACT_PATTERNS = {
  directive: compileActPattern("directive"),
  regulation: compileActPattern("regulation"),
} as const satisfies Record<EuActKind, RegExp>;

const HUNGARIAN_REGULATION_PATTERN = new RegExp(
  String.raw`(?<article>\d+[a-zA-Z]?)\.\s*cikk(?:\s*\((?<parenParagraph>\d+)\)\s*bekezd(?:és)?)?(?:\s*(?<point>[a-z])\)\s*pont)?\s*${YEAR_NUMBER}\s*\/(?:EU|EÚ)\s*${ACT_KIND.regulation}`,
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

const numberedActIdentity = (
  kind: EuActKind,
  groups: Record<string, string | undefined>,
): EuActIdentity | null => {
  const first = groups["first"];
  const second = groups["second"];
  if (first === undefined || second === undefined) {
    return null;
  }
  const explicitlyNumberFirst = groups["hasNumberFirst"] !== undefined;
  const firstNumber = Number(first);
  const secondNumber = Number(second);
  const apparentYear = normalizeYear(first);
  const era = apparentYear >= 2015 ? "from2015" : "before2015";
  const order = explicitlyNumberFirst
    ? "number-year"
    : ACT_NUMBER_ORDERS[kind][era];
  const year = order === "year-number" ? apparentYear : normalizeYear(second);
  const number = order === "year-number" ? secondNumber : firstNumber;
  return actIdentity(kind, year, number);
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
      const act = numberedActIdentity(kind, match.groups ?? {});
      const reference = referenceFrom(match.groups ?? {});
      if (act === null || reference === null) {
        continue;
      }
      citations.push({
        act,
        end: match.index + match[0].length,
        jurisdiction: "EU",
        reference,
        start: match.index,
      });
    }
  }
  HUNGARIAN_REGULATION_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(HUNGARIAN_REGULATION_PATTERN)) {
    const act = numberedActIdentity("regulation", match.groups ?? {});
    const reference = referenceFrom(match.groups ?? {});
    if (act === null || reference === null) {
      continue;
    }
    citations.push({
      act,
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
