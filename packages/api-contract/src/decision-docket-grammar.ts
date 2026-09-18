import { panic } from "better-result";

import type { CaseLawJurisdiction } from "./case-law-jurisdictions";

/** A normalized docket accepted by one jurisdiction's declared grammar. */
export type ParsedDecisionDocket<TJurisdiction extends string = string> = {
  readonly jurisdiction: TJurisdiction;
  readonly formatted: string;
  readonly canonical: string;
};

type DecisionDocketGrammarFor<TJurisdiction extends string> = {
  readonly jurisdiction: TJurisdiction;
  readonly parse: (raw: string) => ParsedDecisionDocket<TJurisdiction> | null;
};

/**
 * Every dash a publisher types where a docket means a hyphen, as a character
 * class body.
 *
 * The range is U+2010 HYPHEN through U+2015 HORIZONTAL BAR plus U+2212 MINUS
 * SIGN: a court's typesetter writes the sheet separator in `8 As 287/2020-33`
 * with the non-breaking U+2011 as readily as with an ASCII hyphen, and a
 * PDF-to-text pass leaves any of the others behind. Exported as a source
 * rather than a helper because the consumers are regular expressions as often
 * as they are string replacements, and a second hand-written class is the way
 * one spelling silently stops matching.
 *
 * The ASCII hyphen leads, where a character class reads it as a literal, so a
 * consumer can append its own members without minting a reversed range.
 */
export const DECISION_DASH_CLASS_SOURCE = String.raw`-‐-―−`;

const DECISION_DASH_RE = new RegExp(`[${DECISION_DASH_CLASS_SOURCE}]`, "gu");

/**
 * Normalize compatibility characters, dash styles, and whitespace before a
 * jurisdiction grammar reads an identifier.
 */
export const foldDecisionIdentifierInput = (raw: string): string =>
  raw
    .normalize("NFKC")
    .replace(DECISION_DASH_RE, "-")
    .replace(/\s+/gu, " ")
    .trim();

export const canonicalDecisionIdentifierKey = (value: string): string =>
  foldDecisionIdentifierInput(value)
    .replace(/-\d{1,4}$/u, "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("und")
    .replace(/\s+/gu, "");

const canonicalDocketKey = canonicalDecisionIdentifierKey;

type CreateDecisionDocketGrammarOptions<TJurisdiction extends string> = {
  readonly jurisdiction: TJurisdiction;
  readonly patterns: readonly RegExp[];
  readonly canonicalize: (formatted: string) => string;
};

const createDecisionDocketGrammar = <const TJurisdiction extends string>({
  canonicalize,
  jurisdiction,
  patterns,
}: CreateDecisionDocketGrammarOptions<TJurisdiction>): DecisionDocketGrammarFor<TJurisdiction> => ({
  jurisdiction,
  parse: (raw) => {
    const formatted = foldDecisionIdentifierInput(raw);
    if (!patterns.some((pattern) => pattern.test(formatted))) {
      return null;
    }
    return {
      jurisdiction,
      formatted,
      canonical: canonicalize(formatted),
    };
  },
});

/**
 * A Czech docket introduced by a senate number or a chamber numeral: `21 Cdo
 * 1234/2020`, `29 NSČR 55/2013`, `IV. ÚS 23/05`. Case-insensitive, because the
 * registry mark is written all-caps (`NSČR`, `ÚS`) and title-case (`Cdo`,
 * `As`) by different courts and lowercase by a reader typing a query.
 */
const CZE_SENATE_DOCKET_RE =
  /^(?:(?:pl|i|ii|iii|iv)\.? ?|\d{1,3} ?)(?:\d{1,3} ?)?\p{L}{1,7}\.? \d{1,6}\/\d{2}(?:\d{2})?(?:-\d{1,4})?$/iu;

/**
 * A Czech docket whose registry mark stands alone, with no senate number in
 * front: `Nad 224/2014`, `Konf 4/2011`, `Nt 408/2023`, `A 9/2003`.
 *
 * Case-sensitive on purpose, and this is the one place in the grammars where
 * casing carries meaning. Court registry marks are title-case in this
 * position, while an agency file number under the same `č. j.` label is an
 * all-caps ministry acronym (`MZDR 6206/2025`). Nothing else in the shape
 * tells the two apart, so a case-insensitive pattern here accepts every
 * ministry reference as a court docket. The cost is that a reader typing such
 * a docket all-lowercase reaches full-text search instead of the exact-docket
 * branch.
 */
const CZE_LETTER_FIRST_DOCKET_RE =
  /^\p{Lu}\p{Ll}{0,6}\.? \d{1,6}\/\d{2}(?:\d{2})?(?:-\d{1,4})?$/u;

const CZE_DOCKET_PATTERNS = [
  CZE_SENATE_DOCKET_RE,
  CZE_LETTER_FIRST_DOCKET_RE,
] as const;
const SVK_DOCKET_RE =
  /^(?<senate>\d{1,3}) ?(?<registry>\p{L}{1,7})(?: ?\/ ?| )(?<ordinal>\d{1,6})\/(?<year>\d{4})$/iu;
const SVK_DOCKET_PATTERNS = [SVK_DOCKET_RE] as const;
/**
 * A Hungarian docket, as the court registry decrees (Büsz. and the OBH's
 * successor rules) prescribe it: an optional Arabic panel number, the registry
 * letters, an optional Roman panel numeral, the register number, the filing
 * year, and, above first instance, the document number.
 *
 * `Pfv.IV.20.123/2020/5` is the Kúria's review register, `Kfv.35.123/2021/8`
 * the same without a panel numeral, and `5.P.21.203/2004.` a first-instance
 * docket, whose panel number leads and whose trailing dot is part of how the
 * court writes it. The register number is typeset with a thousands dot
 * (`20.123`) by the courts and without it (`20123`) by several databases, so
 * both are accepted and the canonical key keeps the digits only.
 */
const HUN_DOCKET_RE =
  /^(?:(?<panel>\d{1,3})\.)?(?<registry>\p{L}{1,5})\.(?:(?<numeral>[ivxlc]{1,5})\.)?(?<register>\d{1,3}\.\d{3}|\d{1,6})\/(?<year>\d{4})(?:\/(?<document>\d{1,4}))?\.?$/iu;
const HUN_DOCKET_PATTERNS = [HUN_DOCKET_RE] as const;
const POL_DOCKET_RE =
  /^(?<chamber>[ivx]{1,5}) (?<division1>\p{L}{1,5})(?:[ /](?<division2>\p{L}{1,5}))? (?<ordinal>\d{1,6})\/(?<year>\d{2}(?:\d{2})?)$/iu;
const POL_DOCKET_PATTERNS = [POL_DOCKET_RE] as const;
const EU_DOCKET_PATTERNS = [
  /^(?:(?:case|vec|věc|sprawa|affaire|rechtssache|causa|asunto) )?[ctf]-\d{1,4}\/\d{2}(?: p)?$/iu,
] as const;
const EU_DOCKET_LEAD_RE =
  /^(?:case|vec|věc|sprawa|affaire|rechtssache|causa|asunto) /iu;
const AUT_DOCKET_PATTERNS = [
  /^\d{1,3} ?[a-z]{1,4} ?\d{1,5}\/\d{2}[a-z]$/iu,
  /^r[aow] ?\d{4}\/\d{2}\/\d{4}$/iu,
  /^[a-z]{1,2} ?\d{1,4}\/\d{4}(?:-\d{1,3})?$/iu,
  /^[a-z]{1,3}\/\d{1,8}\/\d{4}$/iu,
] as const;

const canonicalSlovakDocketKey = (formatted: string): string => {
  const groups = SVK_DOCKET_RE.exec(formatted)?.groups;
  const senate = groups?.["senate"];
  const registry = groups?.["registry"];
  const ordinal = groups?.["ordinal"];
  const year = groups?.["year"];
  if (
    senate === undefined ||
    registry === undefined ||
    ordinal === undefined ||
    year === undefined
  ) {
    return panic("Accepted Slovak docket is missing a canonical component");
  }
  return canonicalDocketKey(`${senate}${registry}/${ordinal}/${year}`);
};

const canonicalHungarianDocketKey = (formatted: string): string => {
  const groups = HUN_DOCKET_RE.exec(formatted)?.groups;
  const registry = groups?.["registry"];
  const register = groups?.["register"];
  const year = groups?.["year"];
  if (registry === undefined || register === undefined || year === undefined) {
    return panic("Accepted Hungarian docket is missing a canonical component");
  }
  const document = groups?.["document"];
  const sheet = document === undefined ? "" : `/${document}`;
  const panel = groups?.["panel"];
  const numeral = groups?.["numeral"];
  // Every component keeps the dot the court writes after it, including when
  // the next one is absent. Concatenated instead, a registry mark followed by
  // a panel numeral and a registry mark ending in those same letters produce
  // one key: `Xy.I.1/2020` and `Xyi.1/2020` are different dockets.
  const lead = panel === undefined ? "" : `${panel}.`;
  const chamber = numeral === undefined ? "" : `${numeral}.`;
  const digits = register.replace(".", "");
  return canonicalDocketKey(
    `${lead}${registry}.${chamber}${digits}/${year}${sheet}`,
  );
};

const canonicalPolishDocketKey = (formatted: string): string => {
  const groups = POL_DOCKET_RE.exec(formatted)?.groups;
  const chamber = groups?.["chamber"];
  const division1 = groups?.["division1"];
  const ordinal = groups?.["ordinal"];
  const year = groups?.["year"];
  if (
    chamber === undefined ||
    division1 === undefined ||
    ordinal === undefined ||
    year === undefined
  ) {
    return panic("Accepted Polish docket is missing a canonical component");
  }
  return canonicalDocketKey(
    `${chamber}${division1}${groups?.["division2"] ?? ""}${ordinal}/${year}`,
  );
};

export const DECISION_DOCKET_GRAMMARS = {
  AUT: createDecisionDocketGrammar({
    canonicalize: canonicalDocketKey,
    jurisdiction: "AUT",
    patterns: AUT_DOCKET_PATTERNS,
  }),
  CZE: createDecisionDocketGrammar({
    canonicalize: (formatted) =>
      canonicalDocketKey(formatted.replaceAll(".", "")),
    jurisdiction: "CZE",
    patterns: CZE_DOCKET_PATTERNS,
  }),
  EU: createDecisionDocketGrammar({
    canonicalize: (formatted) =>
      canonicalDocketKey(formatted.replace(EU_DOCKET_LEAD_RE, "")),
    jurisdiction: "EU",
    patterns: EU_DOCKET_PATTERNS,
  }),
  HUN: createDecisionDocketGrammar({
    canonicalize: canonicalHungarianDocketKey,
    jurisdiction: "HUN",
    patterns: HUN_DOCKET_PATTERNS,
  }),
  POL: createDecisionDocketGrammar({
    canonicalize: canonicalPolishDocketKey,
    jurisdiction: "POL",
    patterns: POL_DOCKET_PATTERNS,
  }),
  SVK: createDecisionDocketGrammar({
    canonicalize: canonicalSlovakDocketKey,
    jurisdiction: "SVK",
    patterns: SVK_DOCKET_PATTERNS,
  }),
} as const satisfies {
  readonly [
    TJurisdiction in CaseLawJurisdiction
  ]: DecisionDocketGrammarFor<TJurisdiction>;
};

export type DecisionDocketJurisdiction = keyof typeof DECISION_DOCKET_GRAMMARS;
export type DecisionDocketGrammar =
  (typeof DECISION_DOCKET_GRAMMARS)[DecisionDocketJurisdiction];

const DECISION_DOCKET_GRAMMAR_LIST: readonly DecisionDocketGrammar[] =
  Object.values(DECISION_DOCKET_GRAMMARS);

/** Resolve a declared grammar without treating an unknown scope as unscoped. */
export const decisionDocketGrammarForJurisdiction = (
  jurisdiction: string,
): DecisionDocketGrammar | null => {
  const normalized = jurisdiction.toUpperCase();
  return (
    DECISION_DOCKET_GRAMMAR_LIST.find(
      (grammar) => grammar.jurisdiction === normalized,
    ) ?? null
  );
};

type ParseDecisionDocketOptions = {
  readonly grammar?: DecisionDocketGrammar | null | undefined;
};

/** Parse against one jurisdiction, or every declared grammar when unscoped. */
export const parseDecisionDocket = (
  raw: string,
  { grammar }: ParseDecisionDocketOptions = {},
): ParsedDecisionDocket | null => {
  if (grammar === null) {
    return null;
  }
  if (grammar !== undefined) {
    return grammar.parse(raw);
  }
  for (const candidate of DECISION_DOCKET_GRAMMAR_LIST) {
    const docket = candidate.parse(raw);
    if (docket !== null) {
      return docket;
    }
  }
  return null;
};

/** Stable normalized display form produced by the accepting grammar. */
export const formatDecisionDocket = (docket: ParsedDecisionDocket): string =>
  docket.formatted;

/** Stable comparison form shared by all declared docket grammars. */
export const canonicalDecisionDocket = (docket: ParsedDecisionDocket): string =>
  docket.canonical;
