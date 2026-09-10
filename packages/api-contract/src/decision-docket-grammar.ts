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
 * Normalize compatibility characters, dash styles, and whitespace before a
 * jurisdiction grammar reads an identifier.
 */
export const foldDecisionIdentifierInput = (raw: string): string =>
  raw
    .normalize("NFKC")
    .replace(/[‐-―−]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();

const canonicalDocketKey = (formatted: string): string =>
  formatted
    .replace(/-\d{1,4}$/u, "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{Z}\s]+/gu, "");

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

const CZE_DOCKET_PATTERNS = [
  /^(?:(?:pl|i|ii|iii|iv)\.? ?)?(?:\d{1,3} ?)?\p{L}{1,7}\.? \d{1,6}\/\d{2}(?:\d{2})?(?:-\d{1,4})?$/iu,
] as const;
const SVK_DOCKET_PATTERNS = [
  /^\d{1,3} ?\p{L}{1,7}(?: ?\/ ?| )\d{1,6}\/\d{4}$/iu,
] as const;
const POL_DOCKET_PATTERNS = [
  /^[ivx]{1,5} \p{L}{1,5} \d{1,6}\/\d{2}(?:\d{2})?$/iu,
] as const;
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

export const DECISION_DOCKET_GRAMMARS = {
  AUT: createDecisionDocketGrammar({
    canonicalize: canonicalDocketKey,
    jurisdiction: "AUT",
    patterns: AUT_DOCKET_PATTERNS,
  }),
  CZE: createDecisionDocketGrammar({
    canonicalize: canonicalDocketKey,
    jurisdiction: "CZE",
    patterns: CZE_DOCKET_PATTERNS,
  }),
  EU: createDecisionDocketGrammar({
    canonicalize: (formatted) =>
      canonicalDocketKey(formatted.replace(EU_DOCKET_LEAD_RE, "")),
    jurisdiction: "EU",
    patterns: EU_DOCKET_PATTERNS,
  }),
  POL: createDecisionDocketGrammar({
    canonicalize: canonicalDocketKey,
    jurisdiction: "POL",
    patterns: POL_DOCKET_PATTERNS,
  }),
  SVK: createDecisionDocketGrammar({
    canonicalize: canonicalDocketKey,
    jurisdiction: "SVK",
    patterns: SVK_DOCKET_PATTERNS,
  }),
} as const;

export type DecisionDocketJurisdiction = keyof typeof DECISION_DOCKET_GRAMMARS;
export type DecisionDocketGrammar =
  (typeof DECISION_DOCKET_GRAMMARS)[DecisionDocketJurisdiction];

const DECISION_DOCKET_GRAMMAR_LIST: readonly DecisionDocketGrammar[] =
  Object.values(DECISION_DOCKET_GRAMMARS);

type ParseDecisionDocketOptions = {
  readonly jurisdiction?: string | undefined;
};

/** Parse against one jurisdiction, or every declared grammar when unscoped. */
export const parseDecisionDocket = (
  raw: string,
  { jurisdiction }: ParseDecisionDocketOptions = {},
): ParsedDecisionDocket | null => {
  const normalizedJurisdiction = jurisdiction?.toUpperCase();
  for (const grammar of DECISION_DOCKET_GRAMMAR_LIST) {
    if (
      normalizedJurisdiction !== undefined &&
      grammar.jurisdiction !== normalizedJurisdiction
    ) {
      continue;
    }
    const docket = grammar.parse(raw);
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
