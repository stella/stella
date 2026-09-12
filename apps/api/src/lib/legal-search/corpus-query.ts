import { panic } from "better-result";

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
 * quadratic in what the reader typed. `spendLeafBudget` decides which of a
 * token's alternatives the ceiling pays for.
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
      policy satisfies never;
      return panic(`Unhandled policy: ${String(policy)}`);
  }
};

/**
 * The order the budget is spent in, which is deliberately not the order a
 * group is written in.
 *
 * Stems come first because they are the alternatives an AND clause cannot do
 * without. Every token is AND-ed, so a word the corpus carries only in
 * another case form matches nothing as a bare surface leaf and empties the
 * whole result set on its own; in an inflected language the most selective
 * word of a long query is routinely the last one, which is exactly the token
 * a single left-to-right pass starves. The stem pass costs tokens × stem
 * fields, so it is bounded by what the reader typed.
 *
 * Dictionary expansion and the other surface fields then spend what is left,
 * left to right. Rarest first would be the better order and no frequency
 * signal reaches this builder to give it: the dictionary payload carries a
 * per-bucket document frequency, but the loader keeps only the forms and
 * `CorpusTermExpander` hands over surface forms alone. Ordering by
 * selectivity means retaining that column at load and exposing it on the
 * expander.
 *
 * The classification field comes last, and being last is the point: it is a
 * generation's newest field and the weakest match on it — the terms a
 * publisher filed a decision under, not what the decision says — so it may
 * only spend what every token's stems and existing alternatives left behind.
 * A generation that maps no such field contributes an empty group, so its
 * clause is what it was before the field existed, leaf for leaf.
 */
const LEAF_BUDGET_PASSES = ["stem", "surface", "keywords"] as const;

/**
 * How the budget pays for one token's alternatives. `stem` is the
 * generation's stem fields, one leaf each; `surface` is every alternative
 * spelling of the word as written — the dictionary's other inflections and
 * the extra surface fields; `keywords` is the publisher's classification
 * field, a different kind of match and the one paid for last.
 *
 * Derived from the passes rather than declared beside them: a group exists
 * because a pass spends it, so there is no way to add one the budget never
 * grants, and every `Record<LeafGroup, …>` below is total over that same list.
 */
type LeafGroup = (typeof LEAF_BUDGET_PASSES)[number];

/**
 * Where a granted group is written inside its OR group, lowest first.
 *
 * A group has always been written surface alternatives first, stems last,
 * which is not the order the budget is spent in. A rank per group keeps the
 * two orders independent without a second hand-listed sequence to drift from
 * the first: the map is total over `LeafGroup`, so a new group has to choose
 * its place rather than inherit one. The classification leaves are written
 * after both, so the group a generation without that field writes stays a
 * prefix of the one it writes with it.
 */
const LEAF_EMIT_RANK = {
  stem: 1,
  surface: 0,
  keywords: 2,
} as const satisfies Record<LeafGroup, number>;

const LEAF_EMIT_ORDER = [...LEAF_BUDGET_PASSES].sort(
  (left, right) => LEAF_EMIT_RANK[left] - LEAF_EMIT_RANK[right],
);

type TokenLeaves = {
  alternatives: Record<LeafGroup, readonly string[]>;
  typed: string;
};

type BudgetedToken = {
  granted: Record<LeafGroup, readonly string[]>;
  token: TokenLeaves;
};

/**
 * Which of each token's alternatives the ceiling could pay for.
 *
 * Both passes run the same rule: a group is granted whole or skipped, never
 * truncated into a clause asking for an arbitrary subset of a word's forms,
 * and a token no pass reaches keeps the surface leaf it always had. So a
 * query long enough that the stem pass alone would cross the ceiling
 * allocates stems left to right and leaves the remaining tokens bare, which
 * is what every token got before this pass existed.
 */
const spendLeafBudget = (tokens: readonly TokenLeaves[]): BudgetedToken[] => {
  const budgeted: BudgetedToken[] = tokens.map((token) => ({
    granted: { stem: [], surface: [], keywords: [] },
    token,
  }));
  let leaves = tokens.length;

  for (const pass of LEAF_BUDGET_PASSES) {
    for (const entry of budgeted) {
      const extras = entry.token.alternatives[pass];
      if (
        extras.length === 0 ||
        leaves + extras.length > CORPUS_QUERY_LEAF_BUDGET
      ) {
        continue;
      }
      leaves += extras.length;
      entry.granted[pass] = extras;
    }
  }

  return budgeted;
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
  /**
   * Classification fields, matched the same way and last in line for the leaf
   * budget, so naming one can never cost a token the alternatives it had
   * without it.
   */
  keywordFields?: readonly string[] | undefined;
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
 * headnote:"slovo" OR text_stem:"slov" OR keywords:"slovo")` — which the
 * engine reads leaf by leaf: the first is matched against the default fields
 * and the rest against the field each names. Every extra leaf is an alternative beside the surface
 * leaf, never instead of it, so a generation with more fields answers
 * everything the same query answered without them, plus the wider matches —
 * a property the leaf budget has to preserve too, which is why its passes are
 * ordered oldest alternative first.
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
    keywordFields = [],
  }: CorpusFreeTextOptions = {},
): string | null => {
  const tokens = tokenizeCorpusFreeText(text);
  if (tokens.length === 0) {
    return null;
  }

  const budgeted = spendLeafBudget(
    tokens.map((token) => ({
      alternatives: {
        stem: stemLeaves(token.value, stemming),
        surface: [
          ...expansionLeaves(token, expand),
          ...surfaceFieldLeaves(token.value, surfaceFields),
        ],
        keywords: surfaceFieldLeaves(token.value, keywordFields),
      },
      typed: quoteCorpusValue(token.value),
    })),
  );

  const clauses = budgeted.map(({ granted, token }) => {
    const extras = LEAF_EMIT_ORDER.flatMap((group) => granted[group]);
    if (extras.length === 0) {
      return token.typed;
    }
    return `(${[token.typed, ...extras].join(" OR ")})`;
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
  keywordFields?: readonly string[] | undefined;
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
  keywordFields,
}: CaseLawCorpusQueryOptions): string | null => {
  const freeText = corpusFreeTextClause(text, {
    expand,
    stemming,
    surfaceFields,
    keywordFields,
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

/**
 * The clause that keeps a source whose redistribution permission was revoked
 * out of an answer.
 *
 * Projection is only the first half of the gate: revoking a permission queues
 * that source's documents for removal, and the engine applies the deletion
 * asynchronously, so a read that named no source clause would keep counting
 * revoked decisions for a reconciliation window. Null when nothing is
 * excluded, so a caller adds no clause rather than an empty one.
 */
export const corpusExcludedSourcesClause = (
  excludedSourceIds: readonly string[],
): string | null =>
  excludedSourceIds.length === 0
    ? null
    : `NOT (${excludedSourceIds
        .map((id) => `source:${quoteCorpusValue(id)}`)
        .join(" OR ")})`;
