import { corpusTokens } from "@/api/lib/legal-search/corpus-tokens";
import type { MorphologyLanguage } from "@/api/lib/legal-search/morphology/stem";
import { stemCorpusText } from "@/api/lib/legal-search/morphology/stem-text";

/**
 * Quote a trusted-shape filter value for a corpus-index field clause.
 * Backslashes are escaped before quotes so a trailing backslash cannot
 * swallow the closing quote and let the remainder parse as DSL.
 */
export const quoteCorpusValue = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * Quote pairs a phrase may be written in. Straight quotes are symmetric; the
 * others are the typographic conventions of the corpus's own jurisdictions
 * (Czech/German „…“, Polish „…”, French/Russian «…», German »…«), so a phrase
 * pasted out of a judgment is read as a phrase rather than as loose words.
 *
 * Single quotes are deliberately absent: an apostrophe inside a word (l'État,
 * d'une) would open a span that never closes and swallow the rest of the query.
 * `“` is both an opener (English) and a valid closer for `„` (Czech); reading
 * it as an opener only where it starts a span keeps both conventions working.
 */
const PHRASE_QUOTE_CLOSERS = new Map<string, string>([
  ['"', '"'],
  ["“", "”"],
  ["„", "“”"],
  ["«", "»"],
  ["»", "«"],
]);

/**
 * Index of the first character in `closers`, or -1. Every quote character is
 * in the BMP, so scanning UTF-16 units cannot split a surrogate pair into a
 * false match.
 */
const findPhraseEnd = (text: string, from: number, closers: string): number => {
  for (let index = from; index < text.length; index += 1) {
    if (closers.includes(text.charAt(index))) {
      return index;
    }
  }
  return -1;
};

/**
 * What one piece of user text asks the engine for. `value` is already reduced
 * to unicode word characters (a phrase's words separated by single spaces), so
 * a consumer never has to re-derive the safety rule. The distinction is not
 * cosmetic: a term may be rewritten — expanded to morphological variants, say —
 * where a phrase may not, because rewriting a phrase's words would silently
 * change what the reader asked to match adjacently.
 */
export type CorpusQueryToken =
  | { type: "phrase"; value: string }
  | { type: "term"; value: string };

/**
 * Split free user text into phrase and term tokens. The single splitter over
 * this input: anything that reads the query's structure (clause building,
 * rewriting) consumes these tokens rather than re-scanning the raw string,
 * so two scanners cannot drift into two answers about where a phrase ends.
 *
 * A balanced quoted span becomes one phrase token. An unbalanced quote carries
 * no span, so its text degrades to ordinary terms rather than to an engine
 * parse error; an empty span yields no token at all. Text without quotes yields
 * exactly the terms it always did.
 */
export const tokenizeCorpusFreeText = (text: string): CorpusQueryToken[] => {
  const tokens: CorpusQueryToken[] = [];
  let plain = "";

  const flushPlain = () => {
    const terms = corpusTokens(plain);
    plain = "";
    for (const term of terms) {
      tokens.push({ type: "term", value: term });
    }
  };

  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const closers = PHRASE_QUOTE_CLOSERS.get(char);
    if (closers === undefined) {
      plain += char;
      index += 1;
      continue;
    }

    const end = findPhraseEnd(text, index + 1, closers);
    if (end === -1) {
      index += 1;
      continue;
    }

    flushPlain();
    const words = corpusTokens(text.slice(index + 1, end));
    if (words.length > 0) {
      tokens.push({ type: "phrase", value: words.join(" ") });
    }
    index = end + 1;
  }
  flushPlain();

  return tokens;
};

/**
 * Extra surface forms to accept alongside a term the reader typed, most
 * useful first. The typed term is deliberately NOT part of the return value:
 * this builder always emits it first, so no expander can drop or reorder what
 * the reader actually wrote. An expander that has nothing to add returns an
 * empty array.
 */
export type CorpusTermExpander = (term: string) => readonly string[];

const noTermExpansion: CorpusTermExpander = () => [];

/**
 * Whether a token kind may be rewritten before it is quoted. A phrase is
 * verbatim because rewriting its words would silently change what the reader
 * asked to match adjacently; a term stands for a word and may carry that
 * word's other inflections. Total over the token union, so a new token kind
 * cannot reach the engine without a decision recorded here.
 *
 * This holds under every expansion mode: no dictionary form is ever
 * substituted into a phrase, so a phrase matches the exact surface forms the
 * reader typed and quoting stays the way to ask for those and no others. The
 * stem leaf beside it is the generation's own and is that same phrase,
 * stemmed word for word, not another wording of it.
 */
const TOKEN_EXPANSION_POLICY = {
  phrase: "verbatim",
  term: "expandable",
} as const satisfies Record<
  CorpusQueryToken["type"],
  "verbatim" | "expandable"
>;

/**
 * Quoted leaves one query may carry. Expansion multiplies leaves per term, so
 * without a ceiling a long query would hand the engine a clause whose cost is
 * quadratic in what the reader typed. Terms are expanded left to right until
 * the next group would cross the ceiling; the rest stay single leaves.
 */
export const CORPUS_QUERY_LEAF_BUDGET = 24;

/**
 * The stem fields a query may name, and the language the reader's words are
 * stemmed against.
 *
 * Both halves are required and neither is guessed: the fields come from the
 * generation's manifest, because a `strict` index rejects a clause over a
 * field it never declared, and the language comes from the query's
 * jurisdiction, because the corpus was stemmed under that language when it was
 * projected. Null wherever either is missing, which is what keeps a query
 * against an older generation byte-identical to what it is today.
 */
export type CorpusStemming = {
  language: MorphologyLanguage;
  fields: readonly string[];
};

/**
 * `field:"stem"` for each stem field, or nothing when the text stems to
 * nothing. The stem is computed from the words as typed, so it is right
 * exactly when the reader wrote the diacritics; a reader who did not still
 * matches the surface fields, and the dictionary expander is what supplies
 * the accented forms in that case.
 */
const stemLeaves = (
  value: string,
  stemming: CorpusStemming | null,
): string[] => {
  if (stemming === null) {
    return [];
  }
  const stem = stemCorpusText(value, stemming.language);
  if (stem === "") {
    return [];
  }
  return stemming.fields.map((field) => `${field}:${quoteCorpusValue(stem)}`);
};

/**
 * `field:"word"` for each extra surface field: the reader's words as typed,
 * against a field the index does not search by default.
 *
 * Naming the field is the whole point. A default search field decides what a
 * bare term matches, and every hit is a passage whose stored `text` is handed
 * on as the excerpt that matched; a field written to the opening passage only
 * would answer with a passage whose text does not carry the terms. A caller
 * that wants those matches asks for them here, and one that needs every hit to
 * be a matching passage simply does not.
 */
const surfaceFieldLeaves = (
  value: string,
  fields: readonly string[],
): string[] => fields.map((field) => `${field}:${quoteCorpusValue(value)}`);

/**
 * Surface forms to accept beside the one the reader typed. A phrase gets
 * none: rewriting its words would silently change what it asked to match
 * adjacently. Total over the token union through `TOKEN_EXPANSION_POLICY`, so
 * a new token kind cannot reach the engine without that decision recorded.
 */
const expansionLeaves = (
  token: CorpusQueryToken,
  expand: CorpusTermExpander,
): string[] => {
  const policy = TOKEN_EXPANSION_POLICY[token.type];
  switch (policy) {
    case "verbatim":
      return [];
    case "expandable":
      return [...expand(token.value)].map(quoteCorpusValue);
    default:
      return policy satisfies never;
  }
};

export type CorpusFreeTextOptions = {
  expand?: CorpusTermExpander | undefined;
  stemming?: CorpusStemming | null | undefined;
  /**
   * Fields matched with the reader's words as typed, beside the default search
   * fields. Empty for a caller whose every hit has to be a passage that
   * carries the terms.
   */
  surfaceFields?: readonly string[] | undefined;
};

/**
 * Convert free user text into a safe corpus-index query clause. The engine's
 * query string syntax (field clauses, AND/OR, parentheses, quotes) must never
 * be reachable from user input, mirroring how the pg-fts path keeps user text
 * literal via plainto_tsquery: keep only unicode word characters, quote each
 * token, AND them. Returns null when no searchable token remains; callers
 * return an empty page without querying the engine.
 *
 * The default search fields record positions, so a bare quoted clause is a
 * positional phrase match over all of them. A phrase and a term are quoted
 * identically because a phrase is no more expressive than a term here: only
 * the grouping differs.
 *
 * A group mixes an unscoped leaf with field-scoped ones — `("slovo" OR
 * headnote:"slovo" OR text_stem:"slov")` — which the engine reads leaf by
 * leaf: the first is matched against the default fields and the rest against
 * the field each names. Every extra leaf is an alternative beside the surface
 * leaf, never instead of it, so a generation with more fields answers
 * everything the same query answered without them, plus the wider matches.
 *
 * With no expander, no extra fields and no stemming this emits exactly what it
 * emitted before any of them existed, byte for byte; the wider forms differ
 * only by OR groups in the positions those features chose.
 */
export const corpusFreeTextClause = (
  text: string,
  {
    expand = noTermExpansion,
    stemming = null,
    surfaceFields = [],
  }: CorpusFreeTextOptions = {},
): string | null => {
  const tokens = tokenizeCorpusFreeText(text);
  if (tokens.length === 0) {
    return null;
  }

  let leaves = tokens.length;
  const clauses = tokens.map((token) => {
    const typed = quoteCorpusValue(token.value);
    const extras = [
      ...expansionLeaves(token, expand),
      ...surfaceFieldLeaves(token.value, surfaceFields),
      ...stemLeaves(token.value, stemming),
    ];
    // The budget is spent left to right: a token whose group would cross it
    // stays a single leaf rather than truncating a group into a clause that
    // asks for something narrower than either alternative.
    if (
      extras.length === 0 ||
      leaves + extras.length > CORPUS_QUERY_LEAF_BUDGET
    ) {
      return typed;
    }
    leaves += extras.length;
    return `(${[typed, ...extras].join(" OR ")})`;
  });

  return `(${clauses.join(" AND ")})`;
};

/**
 * Filters a case-law corpus query may carry, named after the index fields
 * rather than after either caller's request shape. `jurisdiction` selects the
 * index first; it is a clause here only when that index holds other
 * jurisdictions too (`corpusIndexRoute` decides), so a scoped query stays
 * exact without every scoped query paying for a clause its index already
 * implies.
 */
export type CaseLawCorpusFilters = {
  court?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  documentType?: string | undefined;
  jurisdiction?: string | undefined;
  language?: string | undefined;
  source?: string | undefined;
};

export type CaseLawCorpusQueryOptions = {
  text: string;
  filters: CaseLawCorpusFilters;
  expand?: CorpusTermExpander | undefined;
  stemming?: CorpusStemming | null | undefined;
  surfaceFields?: readonly string[] | undefined;
};

/**
 * The one assembler for a case-law corpus-index query. Both read paths (the
 * public search handler and the shared search provider) go through it, so
 * there is a single answer to what the engine sees and a single escaping rule
 * to audit. Null when the free text carries no searchable term: callers return
 * an empty page rather than querying the engine.
 */
export const caseLawCorpusQuery = ({
  text,
  filters,
  expand,
  stemming,
  surfaceFields,
}: CaseLawCorpusQueryOptions): string | null => {
  const freeText = corpusFreeTextClause(text, {
    expand,
    stemming,
    surfaceFields,
  });
  if (freeText === null) {
    return null;
  }

  const clauses: string[] = [freeText];
  if (filters.jurisdiction) {
    clauses.push(`jurisdiction:${quoteCorpusValue(filters.jurisdiction)}`);
  }
  if (filters.documentType) {
    clauses.push(`document_type:${quoteCorpusValue(filters.documentType)}`);
  }
  if (filters.source) {
    clauses.push(`source:${quoteCorpusValue(filters.source)}`);
  }
  if (filters.language) {
    clauses.push(`language:${quoteCorpusValue(filters.language)}`);
  }
  if (filters.court) {
    clauses.push(`court:${quoteCorpusValue(filters.court)}`);
  }
  if (filters.dateFrom || filters.dateTo) {
    clauses.push(
      `decision_date:[${filters.dateFrom ?? "*"} TO ${filters.dateTo ?? "*"}]`,
    );
  }
  return clauses.join(" AND ");
};
