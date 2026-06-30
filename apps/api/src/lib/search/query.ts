import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { applyArabicFolds, normalizeSearchText } from "@stll/text-normalize";

const PREFIX_QUERY_TOKEN_LIMIT = 8;
const ADVANCED_QUERY_OPERATOR_RE =
  /(?:^|\s)(?:AND|OR|NOT)(?:\s|$)|(?:^|\s)-(?=\S)|["()]/u;
const FILE_EXTENSION_RE = /^[\p{L}\p{N}]{1,10}$/u;
const ARABIC_COMPATIBLE_VARIANT_LIMIT = 64;
type ArabicFoldMode = "compatible" | "folded" | "legacy";

const ARABIC_FOLD_TARGET_ALTERNATES: Readonly<
  Record<string, readonly string[]>
> = {
  ا: ["آ", "أ", "إ", "ٱ"],
  و: ["ؤ"],
  ي: ["ئ", "ى"],
  ه: ["ة"],
};

const ARABIC_INDIC_DIGITS: Readonly<Record<string, string>> = {
  "0": "٠",
  "1": "١",
  "2": "٢",
  "3": "٣",
  "4": "٤",
  "5": "٥",
  "6": "٦",
  "7": "٧",
  "8": "٨",
  "9": "٩",
};

const EXTENDED_ARABIC_INDIC_DIGITS: Readonly<Record<string, string>> = {
  "0": "۰",
  "1": "۱",
  "2": "۲",
  "3": "۳",
  "4": "۴",
  "5": "۵",
  "6": "۶",
  "7": "۷",
  "8": "۸",
  "9": "۹",
};

const compact = (parts: readonly (string | null | undefined)[]): string =>
  parts
    .flatMap((part) => {
      const trimmed = part?.trim();
      return trimmed ? [trimmed] : [];
    })
    .join(" ");

/** Normalize file names for search: strip extension,
 *  replace common filename separators with spaces. */
export const normalizeFileNameForSearch = (name: string): string => {
  const lastDot = name.lastIndexOf(".");
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  return base.replace(/[._-]+/gu, " ");
};

export const normalizeFileNameVariantForSearch = (
  query: string,
): string | null => {
  const lastDot = query.lastIndexOf(".");
  const extension = lastDot > 0 ? query.slice(lastDot + 1) : "";
  if (!FILE_EXTENSION_RE.test(extension)) {
    return null;
  }

  return normalizeFileNameForSearch(query);
};

const normalizeTextForLexemes = (text: string): string =>
  text.replace(/[._-]+/gu, " ");

export const removeSearchDiacritics = (text: string): string =>
  text.normalize("NFD").replace(/\p{Diacritic}/gu, "");

export const fileNameSearchText = (name: string): string =>
  compact([
    name,
    ...new Set([
      normalizeFileNameForSearch(name),
      removeSearchDiacritics(normalizeFileNameForSearch(name)),
    ]),
  ]);

const toPrefixTsQueryTextForMode = (
  query: string,
  mode: ArabicFoldMode,
): string | null => {
  const lexemeGroups = toSearchLexemeGroups(query, mode);

  return lexemeGroups.length > 0
    ? lexemeGroups.map(lexemeGroupToTsQuery).join(" & ")
    : null;
};

export const toPrefixTsQueryText = (query: string): string | null =>
  toPrefixTsQueryTextForMode(query, "folded");

const toLooseTsQueryTextForMode = (
  query: string,
  mode: ArabicFoldMode,
): string | null => {
  const lexemeGroups = toSearchLexemeGroups(query, mode);

  return lexemeGroups.length > 1
    ? lexemeGroups
        .flatMap((lexemes) => lexemes.map((lexeme) => `${lexeme}:*`))
        .join(" | ")
    : null;
};

export const toLooseTsQueryText = (query: string): string | null =>
  toLooseTsQueryTextForMode(query, "folded");

type AdvancedToken =
  | { type: "and" | "lparen" | "not" | "or" | "rparen" }
  | { type: "term"; phrase: boolean; value: string };

type SearchAst =
  | { type: "and" | "or"; left: SearchAst; right: SearchAst }
  | { type: "not"; child: SearchAst }
  | { type: "term"; lexemes: string[][]; phrase: boolean };

class AdvancedQueryParser {
  readonly #tokens: AdvancedToken[];
  readonly #mode: ArabicFoldMode;
  #index = 0;

  constructor(tokens: AdvancedToken[], mode: ArabicFoldMode) {
    this.#tokens = tokens;
    this.#mode = mode;
  }

  parse(): SearchAst | null {
    const ast = this.#parseOr();
    if (!ast || this.#peek()) {
      return null;
    }
    return ast;
  }

  #parseOr(): SearchAst | null {
    let left = this.#parseAnd();
    if (!left) {
      return null;
    }

    while (this.#match("or")) {
      const right = this.#parseAnd();
      if (!right) {
        return null;
      }
      left = { type: "or", left, right };
    }

    return left;
  }

  #parseAnd(): SearchAst | null {
    let left = this.#parseNot();
    if (!left) {
      return null;
    }

    while (this.#shouldReadAnd()) {
      this.#match("and");
      const right = this.#parseNot();
      if (!right) {
        return null;
      }
      left = { type: "and", left, right };
    }

    return left;
  }

  #parseNot(): SearchAst | null {
    if (this.#match("not")) {
      const child = this.#parseNot();
      return child ? { type: "not", child } : null;
    }
    return this.#parsePrimary();
  }

  #parsePrimary(): SearchAst | null {
    if (this.#match("lparen")) {
      const expression = this.#parseOr();
      if (!expression || !this.#match("rparen")) {
        return null;
      }
      return expression;
    }

    const token = this.#peek();
    if (token?.type !== "term") {
      return null;
    }

    this.#index += 1;
    const lexemes = toSearchLexemeGroups(token.value, this.#mode);
    return lexemes.length > 0
      ? { type: "term", lexemes, phrase: token.phrase }
      : null;
  }

  #shouldReadAnd(): boolean {
    const token = this.#peek();
    return (
      token?.type === "and" ||
      token?.type === "not" ||
      token?.type === "lparen" ||
      token?.type === "term"
    );
  }

  #match(type: AdvancedToken["type"]): boolean {
    if (this.#peek()?.type !== type) {
      return false;
    }
    this.#index += 1;
    return true;
  }

  #peek(): AdvancedToken | undefined {
    return this.#tokens.at(this.#index);
  }
}

const isAdvancedQuery = (query: string): boolean =>
  ADVANCED_QUERY_OPERATOR_RE.test(query);

const parseAdvancedSearchAst = (
  query: string,
  mode: ArabicFoldMode = "folded",
): SearchAst | null => {
  const tokens = tokenizeAdvancedQuery(query);
  return tokens ? new AdvancedQueryParser(tokens, mode).parse() : null;
};

const hasPositiveTerm = (ast: SearchAst, negated = false): boolean => {
  switch (ast.type) {
    case "term":
      return !negated;
    case "not":
      return hasPositiveTerm(ast.child, !negated);
    case "and":
    case "or":
      return (
        hasPositiveTerm(ast.left, negated) ||
        hasPositiveTerm(ast.right, negated)
      );
    default: {
      const exhaustive: never = ast;
      return exhaustive;
    }
  }
};

export const validateStellaSearchQuery = (
  query: string,
): { valid: true } | { valid: false; reason: string } => {
  const trimmed = query.trim();
  if (!trimmed) {
    return { valid: false, reason: "Query must not be empty." };
  }

  if (!isAdvancedQuery(trimmed)) {
    return { valid: true };
  }

  const ast = parseAdvancedSearchAst(trimmed);
  if (!ast) {
    return {
      valid: false,
      reason:
        "Invalid boolean syntax. Use uppercase AND, OR, NOT, balanced parentheses, and closed quotes.",
    };
  }

  return hasPositiveTerm(ast)
    ? { valid: true }
    : {
        valid: false,
        reason: "Search query must include at least one positive term.",
      };
};

const toSearchLexemes = (
  query: string,
  mode: ArabicFoldMode = "folded",
): string[] =>
  (
    removeSearchDiacritics(normalizeTextForLexemes(query))
      .normalize("NFKC")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
    .map((token) => (mode === "folded" ? applyArabicFolds(token) : token))
    .filter((token) => token.length > 0)
    .slice(0, PREFIX_QUERY_TOKEN_LIMIT);

const toSearchLexemeGroups = (
  query: string,
  mode: ArabicFoldMode = "folded",
): string[][] => {
  if (mode !== "compatible") {
    return toSearchLexemes(query, mode).map((lexeme) => [lexeme]);
  }

  return toSearchLexemes(query, "legacy").map(toCompatibleArabicLexemes);
};

const toCompatibleArabicLexemes = (lexeme: string): string[] => {
  const variants = new Set([lexeme]);
  const folded = applyArabicFolds(lexeme);
  if (folded) {
    variants.add(folded);
    for (const variant of expandArabicFoldTargetVariants(folded)) {
      variants.add(variant);
    }
  }
  return [...variants];
};

const expandArabicFoldTargetVariants = (text: string): string[] => {
  const variants = new Set([text]);

  for (let index = 0; index < text.length; index += 1) {
    const char = text.at(index);
    if (!char) {
      continue;
    }

    const alternates = ARABIC_FOLD_TARGET_ALTERNATES[char];
    if (!alternates) {
      continue;
    }

    for (const variant of [...variants]) {
      for (const alternate of alternates) {
        variants.add(
          `${variant.slice(0, index)}${alternate}${variant.slice(index + char.length)}`,
        );
        if (variants.size >= ARABIC_COMPATIBLE_VARIANT_LIMIT) {
          return [...variants];
        }
      }
    }
  }

  for (const variant of expandAsciiDigitVariants(text)) {
    variants.add(variant);
  }

  return [...variants];
};

const expandAsciiDigitVariants = (text: string): string[] => {
  if (!/[0-9]/u.test(text)) {
    return [];
  }

  return [
    text.replace(/[0-9]/gu, (digit) => ARABIC_INDIC_DIGITS[digit] ?? digit),
    text.replace(
      /[0-9]/gu,
      (digit) => EXTENDED_ARABIC_INDIC_DIGITS[digit] ?? digit,
    ),
  ].filter((variant) => variant !== text);
};

const tokenizeAdvancedQuery = (query: string): AdvancedToken[] | null => {
  const tokens: AdvancedToken[] = [];
  let index = 0;

  while (index < query.length) {
    const char = query.at(index);
    if (!char) {
      break;
    }

    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }

    if (char === "(") {
      tokens.push({ type: "lparen" });
      index += 1;
      continue;
    }

    if (char === ")") {
      tokens.push({ type: "rparen" });
      index += 1;
      continue;
    }

    if (char === '"') {
      const endIndex = query.indexOf('"', index + 1);
      if (endIndex === -1) {
        return null;
      }
      tokens.push({
        type: "term",
        phrase: true,
        value: query.slice(index + 1, endIndex),
      });
      index = endIndex + 1;
      continue;
    }

    if (
      char === "-" &&
      query.at(index + 1) &&
      !/\s/u.test(query.at(index + 1) ?? "")
    ) {
      tokens.push({ type: "not" });
      index += 1;
      continue;
    }

    let endIndex = index + 1;
    while (endIndex < query.length) {
      const next = query.at(endIndex);
      if (!next || /\s|[()"]/u.test(next)) {
        break;
      }
      endIndex += 1;
    }

    const value = query.slice(index, endIndex);
    if (value === "AND") {
      tokens.push({ type: "and" });
    } else if (value === "OR") {
      tokens.push({ type: "or" });
    } else if (value === "NOT") {
      tokens.push({ type: "not" });
    } else {
      tokens.push({ type: "term", phrase: false, value });
    }
    index = endIndex;
  }

  return tokens;
};

const astToTsQuery = (ast: SearchAst): string => {
  switch (ast.type) {
    case "term": {
      const operator = ast.phrase ? " <-> " : " & ";
      return ast.lexemes.map(lexemeGroupToTsQuery).join(operator);
    }
    case "not":
      return `!(${astToTsQuery(ast.child)})`;
    case "and":
      return `(${astToTsQuery(ast.left)}) & (${astToTsQuery(ast.right)})`;
    case "or":
      return `(${astToTsQuery(ast.left)}) | (${astToTsQuery(ast.right)})`;
    default: {
      const exhaustive: never = ast;
      return exhaustive;
    }
  }
};

const lexemeGroupToTsQuery = (lexemes: string[]): string => {
  const variants = lexemes.map((lexeme) => `${lexeme}:*`);
  const first = variants.at(0);
  if (!first) {
    return "";
  }
  return variants.length === 1 ? first : `(${variants.join(" | ")})`;
};

export const toAdvancedTsQueryText = (query: string): string | null => {
  if (!isAdvancedQuery(query)) {
    return null;
  }

  const ast = parseAdvancedSearchAst(query);
  return ast && hasPositiveTerm(ast) ? astToTsQuery(ast) : null;
};

const toCompatibleAdvancedTsQueryText = (query: string): string | null => {
  if (!isAdvancedQuery(query)) {
    return null;
  }

  const ast = parseAdvancedSearchAst(query, "compatible");
  return ast && hasPositiveTerm(ast) ? astToTsQuery(ast) : null;
};

type PlainSearchTsQueryOptions = {
  regconfig?: SQL;
  useUnaccent?: boolean;
};

const SIMPLE_REGCONFIG = sql`'simple'`;

const plainSearchText = (query: string, useUnaccent: boolean) =>
  useUnaccent ? sql`unaccent(${query})` : sql`${query}`;

const normalizedPlainSearchText = (query: string, useUnaccent: boolean) =>
  useUnaccent
    ? sql`unaccent(arabic_normalize(${query}))`
    : sql`arabic_normalize(${query})`;

const buildPlainSearchTsQueryParts = (
  query: string,
  {
    regconfig = SIMPLE_REGCONFIG,
    useUnaccent = true,
  }: PlainSearchTsQueryOptions,
) => {
  const legacyVariants = expandArabicFoldTargetVariants(query);
  const normalized = normalizeSearchText(query);
  const plainQueries = legacyVariants.map(
    (variant) =>
      sql`plainto_tsquery(${regconfig}, ${plainSearchText(variant, useUnaccent)})`,
  );

  if (normalized !== query) {
    plainQueries.push(
      sql`plainto_tsquery(${regconfig}, ${normalizedPlainSearchText(
        query,
        useUnaccent,
      )})`,
    );
  }

  return plainQueries;
};

export const buildPlainSearchTsQuery = (
  query: string,
  options: PlainSearchTsQueryOptions = {},
) =>
  sql`(${sql.join(buildPlainSearchTsQueryParts(query, options), sql` || `)})`;

export const buildSearchTsQuery = (query: string) => {
  const advanced = toCompatibleAdvancedTsQueryText(query);
  if (advanced) {
    return sql`to_tsquery('simple', unaccent(${advanced}))`;
  }

  if (isAdvancedQuery(query.trim())) {
    return sql`plainto_tsquery('simple', '')`;
  }

  const variants = [query, normalizeFileNameVariantForSearch(query)].flatMap(
    (variant) => {
      const trimmed = variant?.trim();
      return trimmed ? [trimmed] : [];
    },
  );
  if (variants.length === 0) {
    return sql`plainto_tsquery('simple', '')`;
  }

  const plainQueries = variants.flatMap((variant) =>
    buildPlainSearchTsQueryParts(variant, {}),
  );
  const prefixQueries = [
    ...new Set(
      variants.flatMap((variant) => {
        const compatible = toPrefixTsQueryTextForMode(variant, "compatible");
        return compatible ? [compatible] : [];
      }),
    ),
  ].map((prefix) => sql`to_tsquery('simple', unaccent(${prefix}))`);
  const looseQueries = [
    ...new Set(
      variants.flatMap((variant) => {
        const compatible = toLooseTsQueryTextForMode(variant, "compatible");
        return compatible ? [compatible] : [];
      }),
    ),
  ].map((loose) => sql`to_tsquery('simple', unaccent(${loose}))`);

  return sql`(${sql.join([...plainQueries, ...prefixQueries, ...looseQueries], sql` || `)})`;
};
