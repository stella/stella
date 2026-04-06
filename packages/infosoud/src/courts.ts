import {
  COURT_CODE_ALIASES,
  COURT_GENERIC_TOKENS,
  COURT_PREFIXES,
  EXTRA_COURTS,
} from "./constants.js";
import type { CourtEntry, CourtMap, CourtType } from "./types.js";

const CODE_PATTERN = /^(?:NS|OS|MS|KS|VS)[A-Z0-9]{0,8}$/u;
const COURT_TOKEN_ALIASES: Record<string, string> = {
  brne: "brno",
  olomouci: "olomouc",
  ostrave: "ostrava",
  pardubicich: "pardubice",
  plzni: "plzen",
  praze: "praha",
};

export const classifyCourtCode = (code: string): CourtType => {
  const normalized = code.trim().toUpperCase();

  if (normalized.startsWith("NS")) {
    return "NS";
  }

  if (normalized.startsWith("VS")) {
    return "VS";
  }

  if (normalized.startsWith("MS")) {
    return "MS";
  }

  if (normalized.startsWith("KS")) {
    return "KS";
  }

  return "OS";
};

export const isCourtCode = (value: string): boolean =>
  CODE_PATTERN.test(value.trim().toUpperCase());

export const resolveCourtCodeAlias = (code: string): string =>
  COURT_CODE_ALIASES[code.trim().toUpperCase()] ?? code.trim().toUpperCase();

export const buildCourtMapFromEntries = (
  courts: readonly CourtEntry[],
): CourtMap => {
  const result: CourtMap = { ...EXTRA_COURTS };

  for (const court of courts) {
    result[court.kod] = court.nazev;
  }

  return result;
};

export const normalizeCourtQuery = (value: string): string => {
  let normalized = value
    .trim()
    .toLocaleLowerCase("cs-CZ")
    .normalize("NFD")
    .replaceAll(/([a-z])(\d)/gu, "$1 $2")
    .replaceAll(/(\d)([a-z])/gu, "$1 $2")
    .replaceAll(/\p{Diacritic}/gu, "")
    .replaceAll(/[-–—,/]+/gu, " ")
    .replaceAll(/\s+/gu, " ");

  let strippedPrefix = true;
  while (strippedPrefix) {
    strippedPrefix = false;
    for (const prefix of COURT_PREFIXES) {
      if (normalized.startsWith(`${prefix} `)) {
        normalized = normalized.slice(prefix.length + 1).trim();
        strippedPrefix = true;
        break;
      }
    }
  }

  return normalized;
};

const detectCourtTypeHint = (value: string): CourtType | null => {
  const normalized = value
    .trim()
    .toLocaleLowerCase("cs-CZ")
    .normalize("NFD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .replaceAll(/[-–—,/]+/gu, " ")
    .replaceAll(/\s+/gu, " ");
  const tokens = normalized.split(" ");

  if (tokens.includes("ns") || tokens.includes("nejvyssi")) {
    return "NS";
  }

  if (tokens.includes("vs") || tokens.includes("vrchni")) {
    return "VS";
  }

  if (tokens.includes("ms") || tokens.includes("mestsky")) {
    return "MS";
  }

  if (tokens.includes("ks") || tokens.includes("krajsky")) {
    return "KS";
  }

  if (
    tokens.includes("os") ||
    tokens.includes("okresni") ||
    tokens.includes("obvodni")
  ) {
    return "OS";
  }

  return null;
};

const compactCourtValue = (value: string): string => value.replaceAll(" ", "");
const normalizeCourtToken = (token: string): string =>
  COURT_TOKEN_ALIASES[token] ?? token;

const tokenizeCourtValue = (value: string): string[] => {
  const normalized = normalizeCourtQuery(value);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(" ")
    .map(normalizeCourtToken)
    .filter((token) => token.length > 0 && !COURT_GENERIC_TOKENS.has(token));
};

const isTokenSubset = (
  queryTokens: readonly string[],
  candidateTokens: readonly string[],
): boolean => queryTokens.every((token) => candidateTokens.includes(token));

export const resolveCourtCode = (
  query: string,
  courtMap: CourtMap,
): string | null => {
  const normalizedQuery = normalizeCourtQuery(query);
  if (!normalizedQuery) {
    return null;
  }

  const queryCompact = compactCourtValue(normalizedQuery);
  const queryCourtType = detectCourtTypeHint(query);
  const queryTokens = tokenizeCourtValue(query);
  const canFuzzyMatch = queryTokens.length > 0;
  let bestCode: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const [code, fullName] of Object.entries(courtMap)) {
    const normalizedCode = resolveCourtCodeAlias(code);
    const candidateCourtType = classifyCourtCode(normalizedCode);
    const normalizedName = normalizeCourtQuery(fullName);
    const normalizedCodeQuery = normalizeCourtQuery(normalizedCode);
    const codeCompact = compactCourtValue(normalizedCodeQuery);
    const nameCompact = compactCourtValue(normalizedName);
    const nameTokens = tokenizeCourtValue(fullName);

    let score = Number.NEGATIVE_INFINITY;

    if (
      normalizedCodeQuery === normalizedQuery ||
      codeCompact === queryCompact
    ) {
      score = 1300;
    } else if (
      normalizedName === normalizedQuery ||
      nameCompact === queryCompact
    ) {
      score = 1200;
    } else if (canFuzzyMatch && isTokenSubset(queryTokens, nameTokens)) {
      score =
        1000 +
        queryTokens.length / Math.max(nameTokens.length, queryTokens.length);
    } else if (canFuzzyMatch && normalizedName.startsWith(normalizedQuery)) {
      score = 800 + normalizedQuery.length / normalizedName.length;
    } else if (canFuzzyMatch && normalizedName.includes(normalizedQuery)) {
      score = 600 + normalizedQuery.length / normalizedName.length;
    }

    if (score > Number.NEGATIVE_INFINITY && queryCourtType) {
      score += candidateCourtType === queryCourtType ? 200 : -200;
    }

    if (score > bestScore) {
      bestScore = score;
      bestCode = normalizedCode;
    }
  }

  return bestScore > Number.NEGATIVE_INFINITY ? bestCode : null;
};
