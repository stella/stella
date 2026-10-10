import { panic } from "better-result";

import { DECISION_TYPE_KIND_OTHER } from "@stll/api-contract/case-law-decision-types";
import type {
  JurisdictionProfile,
  WorkIdentifier,
} from "@stll/legal-atlas/provision-citation-profile";
import { provisionCitationProfileFor } from "@stll/legal-atlas/provision-citation-profiles";
import { foldToAscii } from "@stll/text-normalize";

import {
  decisionTypeFilter,
  KINDED_DECISION_TYPES,
  statedDecisionTypesOf,
} from "@/api/lib/case-law/decision-type-kind";
import { COURT_PARTITION_FIELD } from "@/api/lib/legal-search/corpus-index-group-contract";
import {
  type CorpusProvisionMention,
  readCorpusProvisionMentions,
} from "@/api/lib/legal-search/corpus-provision-mentions";
import {
  CORPUS_QUERY_VARIANT_POLICY,
  type CorpusIndexQueryVariant,
} from "@/api/lib/legal-search/corpus-query-variant-policy";
import { corpusTokens } from "@/api/lib/legal-search/corpus-tokens";
import { functionWordKey } from "@/api/lib/legal-search/morphology/function-words";
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
      plain += char;
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
 * What a query requires and what it stopped requiring.
 *
 * `dropped` carries the words as the reader wrote them, not their comparison
 * keys: it is read back to the reader ("searched without: jak, musí, být")
 * and quoting a normalised form at someone who typed something else reads as
 * a different query than the one they ran.
 */
export type CorpusQueryPartition = {
  /** The tokens the clause is built from, in input order. */
  required: readonly CorpusQueryToken[];
  /** Term tokens left out as function words, in input order. */
  dropped: readonly string[];
};

/**
 * Split a query's tokens into the ones it requires and the function words it
 * does not.
 *
 * The one owner of the rule, called both by the clause builder and by
 * whatever reports the query back to its caller, so the clause and the
 * report cannot disagree about which words were required.
 *
 * Three things are never dropped. A phrase, because its words are what it
 * asked to match adjacently, and dropping one silently changes the phrase
 * ({@link TOKEN_EXPANSION_POLICY} keeps a phrase verbatim for the same
 * reason). Anything at all when `functionWords` is null: no language was
 * resolved, so no list applies. And the last remaining token — a query made
 * only of function words ("jak a kdy") keeps every one of them and stays as
 * strict as it is today, because a clause built from nothing is not a
 * broader search, it is no search.
 */
export const partitionCorpusFunctionWords = (
  tokens: readonly CorpusQueryToken[],
  functionWords: ReadonlySet<string> | null,
): CorpusQueryPartition => {
  if (functionWords === null) {
    return { required: tokens, dropped: [] };
  }
  const required: CorpusQueryToken[] = [];
  const dropped: string[] = [];
  for (const token of tokens) {
    if (
      token.type === "term" &&
      functionWords.has(functionWordKey(token.value))
    ) {
      dropped.push(token.value);
      continue;
    }
    required.push(token);
  }
  if (required.length === 0) {
    return { required: tokens, dropped: [] };
  }
  return { required, dropped };
};

type PartitionCorpusQueryTokensOptions = {
  tokens: readonly CorpusQueryToken[];
  functionWords: ReadonlySet<string> | null;
  queryVariant: CorpusIndexQueryVariant;
  jurisdiction: string | undefined;
};

type PartitionCorpusQueryTokensResult = {
  baseline: CorpusQueryPartition;
  partition: CorpusQueryPartition;
  profile: JurisdictionProfile | null;
  mentions: readonly CorpusProvisionMention[];
};

/** Share original provision spans between clause construction and query reporting. */
export const partitionCorpusQueryTokens = ({
  tokens,
  functionWords,
  queryVariant,
  jurisdiction,
}: PartitionCorpusQueryTokensOptions): PartitionCorpusQueryTokensResult => {
  const profile =
    CORPUS_QUERY_VARIANT_POLICY[queryVariant].provisions &&
    jurisdiction !== undefined
      ? provisionCitationProfileFor(jurisdiction)
      : null;
  const mentions =
    profile === null ? [] : readCorpusProvisionMentions(tokens, profile);
  const baseline = partitionCorpusFunctionWords(tokens, functionWords);
  if (mentions.length === 0 || baseline.dropped.length === 0) {
    return { baseline, partition: baseline, profile, mentions };
  }
  const retained = new Set(baseline.required);
  for (const { consumedRange } of mentions) {
    for (const token of tokens.slice(consumedRange.start, consumedRange.end)) {
      retained.add(token);
    }
  }
  const partition = {
    required: tokens.filter((token) => retained.has(token)),
    dropped: tokens.flatMap((token) =>
      token.type === "term" && !retained.has(token) ? [token.value] : [],
    ),
  };
  return { baseline, partition, profile, mentions };
};

/**
 * Tokens written back as a query string.
 *
 * The inverse of {@link tokenizeCorpusFreeText}, and a fixed point of it: a
 * phrase keeps its quotes, so re-tokenising this string yields the tokens it
 * was built from. That is what lets a caller send a reported `queryUsed`
 * back as `query` and get the same clause, instead of a query whose phrases
 * have decayed into loose words.
 */
export const formatCorpusQueryTokens = (
  tokens: readonly CorpusQueryToken[],
): string =>
  tokens
    .map((token) =>
      token.type === "phrase" ? `"${token.value}"` : token.value,
    )
    .join(" ");

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

export type CorpusLegacyStemming = {
  fields: readonly string[];
  stemTerm: (term: string) => string;
};

type LegacyStemLeavesOptions = {
  token: CorpusQueryToken;
  legacyStemming: CorpusLegacyStemming;
  stemming: CorpusStemming | null;
};

/** Query compatibility with stems already stored by an older projection. */
const legacyStemLeaves = ({
  token,
  legacyStemming: { fields, stemTerm },
  stemming,
}: LegacyStemLeavesOptions): string[] => {
  if (token.type === "phrase") {
    return [];
  }
  const faithful = corpusTokens(token.value)
    .map((term) => {
      const normalized = term.normalize("NFC").toLowerCase();
      return stemTerm(normalized) || normalized;
    })
    .join(" ");
  const primaryLeaves = new Set(stemLeaves(token.value, stemming));
  return fields
    .map((field) => `${field}:${quoteCorpusValue(faithful)}`)
    .filter((leaf) => !primaryLeaves.has(leaf));
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
 * The legal-vocabulary alternatives a term stands for, each as a surface leaf
 * plus its own stem leaves, so "kauce" also finds "jistoty" and "jistotu". A
 * phrase gets none, under the same policy that keeps it from morphological
 * expansion: adding words to a phrase would change what it asked to match
 * adjacently.
 */
const legalAlternativeLeaves = (
  token: CorpusQueryToken,
  legalAlternatives: CorpusTermExpander | null,
  stemming: CorpusStemming | null,
): string[] => {
  if (legalAlternatives === null) {
    return [];
  }
  const policy = TOKEN_EXPANSION_POLICY[token.type];
  switch (policy) {
    case "verbatim":
      return [];
    case "expandable": {
      const leaves: string[] = [];
      for (const alternative of legalAlternatives(token.value)) {
        leaves.push(
          quoteCorpusValue(alternative),
          ...stemLeaves(alternative, stemming),
        );
      }
      return leaves;
    }
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
 * Legal-vocabulary alternatives come right after the stems, for the same
 * reason: a reader who typed the everyday word ("kauce") matches almost
 * nothing when the corpus writes the statutory one ("jistota"), so that
 * alternative is what keeps the AND clause from emptying.
 *
 * The classification field comes last, and being last is the point: it is a
 * generation's newest field and the weakest match on it — the terms a
 * publisher filed a decision under, not what the decision says — so it may
 * only spend what every token's stems and existing alternatives left behind.
 * A generation that maps no such field contributes an empty group, so its
 * clause is what it was before the field existed, leaf for leaf.
 */
const LEAF_BUDGET_PASSES = ["stem", "legal", "surface", "keywords"] as const;

/**
 * How the budget pays for one token's alternatives. `stem` is the
 * generation's stem fields, one leaf each; `surface` is every alternative
 * spelling of the word as written — the dictionary's other inflections and
 * the extra surface fields; `legal` is the legal-vocabulary alternatives
 * the term stands for, each with its own stems; `keywords` is the publisher's
 * classification field, a different kind of match and the one paid for last.
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
 * prefix of the one it writes with it. Legal alternatives are written last
 * for the same reason: a query that carries none keeps its groups byte for
 * byte.
 */
const LEAF_EMIT_RANK = {
  stem: 1,
  surface: 0,
  keywords: 2,
  legal: 3,
} as const satisfies Record<LeafGroup, number>;

const LEAF_EMIT_ORDER = [...LEAF_BUDGET_PASSES].toSorted(
  (left, right) => LEAF_EMIT_RANK[left] - LEAF_EMIT_RANK[right],
);

type TokenLeaves = {
  alternatives: Record<LeafGroup, readonly string[]>;
  typed: string;
};

type CoreStemLeaves = {
  primary: string[];
  faithful: string[];
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
const spendLeafBudget = (
  tokens: readonly TokenLeaves[],
  reserved = 0,
): BudgetedToken[] => {
  const budgeted: BudgetedToken[] = tokens.map((token) => ({
    granted: { stem: [], surface: [], keywords: [], legal: [] },
    token,
  }));
  let leaves = tokens.length + reserved;

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

type ReserveCoreStemLeavesOptions = {
  tokens: readonly CorpusQueryToken[];
  leavesForTokens: TokenLeaves[];
  reserved: number;
  queryVariant: CorpusIndexQueryVariant;
  stemming: CorpusStemming | null;
  legacyStemming: CorpusLegacyStemming | null;
};

/** Reserve passage stems across all tokens before optional fields spend headroom. */
const reserveCoreStemLeaves = ({
  tokens,
  leavesForTokens,
  reserved,
  queryVariant,
  stemming,
  legacyStemming,
}: ReserveCoreStemLeavesOptions) => {
  const coreReserved: CoreStemLeaves[] = tokens.map(() => ({
    primary: [],
    faithful: [],
  }));
  let coreCount = 0;
  if (
    CORPUS_QUERY_VARIANT_POLICY[queryVariant].coreStemsFirst &&
    legacyStemming !== null &&
    legacyStemming.fields.length > 0
  ) {
    // Give every token its primary stem before spending on faithful variants.
    // Typed leaves remain mandatory even for all-token queries above the ceiling.
    for (const kind of ["primary", "faithful"] as const) {
      for (const [index, token] of tokens.entries()) {
        const leaves = leavesForTokens.at(index);
        const core = coreReserved.at(index);
        if (leaves === undefined || core === undefined) {
          return panic("Required corpus token has no core reservation");
        }
        const leaf =
          kind === "primary"
            ? leaves.alternatives.stem.at(0)
            : legacyStemLeaves({ token, legacyStemming, stemming }).at(0);
        if (
          leaf === undefined ||
          core.primary.includes(leaf) ||
          core.faithful.includes(leaf) ||
          tokens.length + reserved + coreCount >= CORPUS_QUERY_LEAF_BUDGET
        ) {
          continue;
        }
        core[kind].push(leaf);
        coreCount += 1;
      }
    }
    for (const [index, leaves] of leavesForTokens.entries()) {
      const core = coreReserved.at(index);
      if (core === undefined) {
        return panic("Corpus token has no core reservation");
      }
      leaves.alternatives.stem = leaves.alternatives.stem.filter(
        (leaf) => !core.primary.includes(leaf) && !core.faithful.includes(leaf),
      );
    }
  }
  return { coreReserved, coreCount };
};

const sameWork = (left: WorkIdentifier, right: WorkIdentifier): boolean =>
  left.number === right.number &&
  left.year === right.year &&
  left.collection === right.collection;

// Historical gazette numbers leave first; the typed act is always retained.
// Headnotes are optional, so their stem phrase leaves before passage stems.
const PROVISION_LEAF_DROP_ORDER = [
  "predecessorGazette",
  "headnoteStem",
  "stem",
  "surface",
  "titles",
  "gazette",
  "aliases",
] as const;

type ProvisionLeafDropGroup = (typeof PROVISION_LEAF_DROP_ORDER)[number];

type CorpusProvisionGroupsOptions = {
  tokens: readonly CorpusQueryToken[];
  requiredTokens: readonly CorpusQueryToken[];
  mentions: readonly CorpusProvisionMention[];
  profile: JurisdictionProfile;
  stemming: CorpusStemming | null;
  surfaceFields: readonly string[];
  leavesForToken: (token: CorpusQueryToken) => TokenLeaves;
};

/** Reserve act alternatives before the ordinary allocator spends any leaves. */
const corpusProvisionGroups = ({
  tokens,
  requiredTokens,
  mentions,
  profile,
  stemming,
  surfaceFields,
  leavesForToken,
}: CorpusProvisionGroupsOptions) => {
  if (mentions.length === 0) {
    return null;
  }
  const retained = new Set(requiredTokens);
  const required: CorpusQueryToken[] = [];
  const groups: {
    index: number;
    leaves: string[];
    dropGroups: Record<ProvisionLeafDropGroup, readonly string[]>;
    typedLeaf: string;
  }[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const mention = mentions.find(
      ({ consumedRange }) => consumedRange.start === index,
    );
    if (mention === undefined) {
      const token = tokens.at(index);
      if (token === undefined) {
        return panic("Corpus provision token index is missing");
      }
      if (retained.has(token)) {
        required.push(token);
      }
      continue;
    }
    const typed = tokens
      .slice(mention.actTokenRange.start, mention.actTokenRange.end)
      .map(({ value }) => value)
      .join(" ");
    const namesForWorks = (entries: JurisdictionProfile["titles"]) =>
      entries
        .filter(({ identifier }) =>
          mention.works.some((work) => sameWork(identifier, work)),
        )
        .flatMap(({ spellings }) =>
          spellings.map((spelling) =>
            quoteCorpusValue(corpusTokens(spelling).join(" ")),
          ),
        );
    const typedLeaf = quoteCorpusValue(typed);
    const titles = namesForWorks(profile.titles).filter(
      (leaf) => leaf !== typedLeaf,
    );
    const aliases = namesForWorks(profile.aliases);
    const gazetteLeaf = ({ number, year }: WorkIdentifier) =>
      quoteCorpusValue(corpusTokens(`${number} ${year}`).join(" "));
    const gazette = mention.works.map(gazetteLeaf);
    const key = foldToAscii(typed).toLowerCase();
    // Only the spelling actually cited determines succession. An older act's
    // explicit historical title may itself have an unbounded citation window.
    const citedEntries = [...profile.titles, ...profile.aliases].filter(
      ({ spellings }) =>
        spellings.some(
          (spelling) =>
            foldToAscii(corpusTokens(spelling).join(" ")).toLowerCase() === key,
        ),
    );
    const predecessorGazette = mention.works
      .filter((work) => {
        const entries = citedEntries.filter(({ identifier }) =>
          sameWork(identifier, work),
        );
        return (
          entries.length > 0 &&
          entries.every(({ citedUntil }) => citedUntil !== undefined)
        );
      })
      .map(gazetteLeaf);
    const surface = surfaceFieldLeaves(typed, surfaceFields);
    const stems = stemLeaves(typed, stemming);
    const leaves = [
      ...new Set([
        typedLeaf,
        ...titles,
        ...surface,
        ...stems,
        ...aliases,
        ...gazette,
      ]),
    ];
    const dropGroups = {
      predecessorGazette,
      headnoteStem: stems.filter((leaf) => leaf.startsWith("headnote_stem:")),
      stem: stems.filter((leaf) => !leaf.startsWith("headnote_stem:")),
      surface: surface.toReversed(),
      titles: titles.toReversed(),
      gazette: gazette.filter((leaf) => !predecessorGazette.includes(leaf)),
      aliases: aliases.toReversed(),
    } satisfies Record<ProvisionLeafDropGroup, readonly string[]>;
    groups.push({ index: required.length, leaves, dropGroups, typedLeaf });
    index = mention.consumedRange.end - 1;
  }
  const tokenLeaves = required.map(leavesForToken);
  // Preserve baseline stem coverage; the remaining optional alternatives use
  // the ordinary whole-group allocator after the act reservation.
  const baseline =
    tokenLeaves.length +
    tokenLeaves.reduce(
      (count, token) => count + token.alternatives.stem.length,
      0,
    );
  let reserved = groups.reduce(
    (count, group) => count + group.leaves.length,
    0,
  );
  for (const kind of PROVISION_LEAF_DROP_ORDER) {
    for (const group of groups.toReversed()) {
      for (const leaf of group.dropGroups[kind]) {
        if (baseline + reserved <= CORPUS_QUERY_LEAF_BUDGET) {
          break;
        }
        const index = group.leaves.indexOf(leaf);
        if (index !== -1 && leaf !== group.typedLeaf) {
          group.leaves.splice(index, 1);
          reserved -= 1;
        }
      }
    }
  }
  if (baseline + reserved > CORPUS_QUERY_LEAF_BUDGET) {
    return null;
  }
  return {
    required,
    reserved,
    groups: groups.map(({ index, leaves }) => ({
      index,
      clause:
        leaves.length === 1
          ? (leaves.at(0) ?? panic("Empty provision group"))
          : `(${leaves.join(" OR ")})`,
    })),
  };
};

export type CorpusFreeTextOptions = {
  queryVariant?: CorpusIndexQueryVariant | undefined;
  jurisdiction?: string | undefined;
  /** Whether content tokens are all required or ranked by coverage. */
  match?: "all" | "any" | undefined;
  /** Declared compatibility fields and algorithm; the variant controls reservation. */
  legacyStemming?: CorpusLegacyStemming | null | undefined;
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
  /**
   * Words this query may stop requiring, in the language it is asked in.
   * Null leaves every token required, which is what a query with no
   * resolved language, an identifier, or `strict` asks for.
   */
  functionWords?: ReadonlySet<string> | null | undefined;
  /**
   * The words the jurisdiction's statutes and courts use for what the reader
   * typed, ORed in beside each term with their own stems. Null adds none,
   * which is what `strict`, an identifier, and a reader with no AI ask for.
   */
  legalAlternatives?: CorpusTermExpander | null | undefined;
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
 * only by OR groups in the positions those features chose. The query variant
 * off, or a query with no provision mention, keeps the existing path byte-identical.
 */
export const corpusFreeTextClause = (
  text: string,
  {
    match = "all",
    queryVariant = "off",
    jurisdiction,
    expand = noTermExpansion,
    stemming = null,
    surfaceFields = [],
    keywordFields = [],
    functionWords = null,
    legalAlternatives = null,
    legacyStemming = null,
  }: CorpusFreeTextOptions = {},
): string | null => {
  const tokens = tokenizeCorpusFreeText(text);
  const { baseline, partition, profile, mentions } = partitionCorpusQueryTokens(
    {
      tokens,
      functionWords,
      queryVariant,
      jurisdiction,
    },
  );
  const partitionRequired =
    match === "any"
      ? baseline.required.slice(0, CORPUS_QUERY_LEAF_BUDGET)
      : baseline.required;
  if (partitionRequired.length === 0) {
    return null;
  }

  const leavesForToken = (token: CorpusQueryToken): TokenLeaves => ({
    alternatives: {
      stem: stemLeaves(token.value, stemming),
      surface: [
        ...expansionLeaves(token, expand),
        ...surfaceFieldLeaves(token.value, surfaceFields),
      ],
      keywords: surfaceFieldLeaves(token.value, keywordFields),
      legal: legalAlternativeLeaves(token, legalAlternatives, stemming),
    },
    typed: quoteCorpusValue(token.value),
  });
  const provisionGroups =
    profile !== null
      ? corpusProvisionGroups({
          tokens,
          requiredTokens: partition.required,
          mentions,
          profile,
          stemming,
          surfaceFields,
          leavesForToken,
        })
      : null;
  const required = provisionGroups?.required ?? partitionRequired;
  const reserved = provisionGroups?.reserved ?? 0;
  const tokenLeaves = required.map(leavesForToken);
  const { coreReserved, coreCount } = reserveCoreStemLeaves({
    tokens: required,
    leavesForTokens: tokenLeaves,
    reserved,
    queryVariant,
    stemming,
    legacyStemming,
  });
  const budgeted = spendLeafBudget(tokenLeaves, reserved + coreCount);

  let used =
    reserved +
    coreCount +
    budgeted.length +
    budgeted.reduce(
      (total, { granted }) =>
        total +
        LEAF_BUDGET_PASSES.reduce(
          (count, group) => count + granted[group].length,
          0,
        ),
      0,
    );
  const clauses = budgeted.map(({ granted, token }, index) => {
    const core = coreReserved.at(index);
    if (core === undefined) {
      return panic("Budgeted corpus token has no core reservation");
    }
    const extras = LEAF_EMIT_ORDER.flatMap((group) =>
      group === "stem" ? core.primary.concat(granted[group]) : granted[group],
    );
    extras.push(...core.faithful);
    // Additional compatibility fields spend only what the ordinary passes left.
    if (
      legacyStemming !== null &&
      legacyStemming.fields.length > 0 &&
      granted.stem.length > 0 &&
      used < CORPUS_QUERY_LEAF_BUDGET
    ) {
      const requiredToken = required.at(index);
      if (requiredToken === undefined) {
        return panic("Budgeted corpus token has no required token");
      }
      const faithful = [
        ...new Set(
          legacyStemLeaves({ token: requiredToken, legacyStemming, stemming }),
        ),
      ].filter((leaf) => !extras.includes(leaf));
      if (used + faithful.length <= CORPUS_QUERY_LEAF_BUDGET) {
        extras.push(...faithful);
        used += faithful.length;
      }
    }
    if (extras.length === 0) {
      return token.typed;
    }
    return `(${[token.typed, ...extras].join(" OR ")})`;
  });

  if (provisionGroups !== null) {
    for (const { index, clause } of provisionGroups.groups.toReversed()) {
      clauses.splice(index, 0, clause);
    }
  }
  return `(${clauses.join(match === "all" ? " AND " : " OR ")})`;
};

/**
 * The engine clause for a request's `decisionType`. The index stores the type
 * as stated, in a raw (exact, case-sensitive) field, so a kind is every
 * spelling the census maps to it, and the catch-all kind is a stated type
 * none of them is. A value no kind claims is matched as stated.
 */
export const corpusDecisionTypeClause = (requested: string): string => {
  const filter = decisionTypeFilter(requested);
  switch (filter.type) {
    case "kind": {
      const spellings = (stated: readonly string[]) =>
        `(${stated
          .map((spelling) => `document_type:${quoteCorpusValue(spelling)}`)
          .join(" OR ")})`;
      if (filter.kind === DECISION_TYPE_KIND_OTHER) {
        return `(document_type:* AND NOT ${spellings(KINDED_DECISION_TYPES)})`;
      }
      return spellings(statedDecisionTypesOf(filter.kind));
    }
    case "stated":
      return `document_type:${quoteCorpusValue(filter.stated)}`;
    default:
      filter satisfies never;
      return panic(`Unhandled decision type filter: ${String(filter)}`);
  }
};

/**
 * Filters a case-law corpus query may carry, named after the index fields
 * rather than after either caller's request shape. `jurisdiction` selects the
 * index first; it is a clause here only when that index holds other
 * jurisdictions too (`corpusIndexRoute` decides), so a scoped query stays
 * exact without every scoped query paying for a clause its index already
 * implies.
 */
type CaseLawCorpusFilters = {
  court?: string | undefined;
  courts?: readonly string[] | undefined;
  /**
   * Partitions the court filter's documents all carry, added beside the
   * exact court clause so the engine can skip splits; never alone
   * (`courtPartitionsForCourtFilter`).
   */
  courtPartitions?: readonly string[] | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  documentType?: string | undefined;
  jurisdiction?: string | undefined;
  language?: string | undefined;
  source?: string | undefined;
};

export type CaseLawCorpusQueryOptions = {
  queryVariant?: CorpusIndexQueryVariant | undefined;
  text: string;
  /** Query scope, independent of whether the target index needs a filter clause. */
  jurisdiction: string | undefined;
  filters: CaseLawCorpusFilters;
  legacyStemming?: CorpusLegacyStemming | null | undefined;
  expand?: CorpusTermExpander | undefined;
  stemming?: CorpusStemming | null | undefined;
  surfaceFields?: readonly string[] | undefined;
  keywordFields?: readonly string[] | undefined;
  functionWords?: ReadonlySet<string> | null | undefined;
  legalAlternatives?: CorpusTermExpander | null | undefined;
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
  jurisdiction,
  queryVariant,
  filters,
  expand,
  stemming,
  surfaceFields,
  keywordFields,
  functionWords,
  legalAlternatives,
  legacyStemming,
}: CaseLawCorpusQueryOptions): string | null => {
  const freeText = corpusFreeTextClause(text, {
    jurisdiction,
    queryVariant,
    expand,
    stemming,
    surfaceFields,
    keywordFields,
    functionWords,
    legalAlternatives,
    legacyStemming,
  });
  if (freeText === null) {
    return null;
  }

  const clauses: string[] = [freeText];
  if (filters.jurisdiction) {
    clauses.push(`jurisdiction:${quoteCorpusValue(filters.jurisdiction)}`);
  }
  if (filters.documentType) {
    clauses.push(corpusDecisionTypeClause(filters.documentType));
  }
  if (filters.source) {
    clauses.push(`source:${quoteCorpusValue(filters.source)}`);
  }
  if (filters.language) {
    clauses.push(`language:${quoteCorpusValue(filters.language)}`);
  }
  if (filters.court) {
    clauses.push(`court:${quoteCorpusValue(filters.court)}`);
    const partitions = filters.courtPartitions;
    if (partitions !== undefined && partitions.length > 0) {
      clauses.push(
        `(${partitions
          .map(
            (partition) =>
              `${COURT_PARTITION_FIELD}:${quoteCorpusValue(partition)}`,
          )
          .join(" OR ")})`,
      );
    }
  }
  if (filters.courts !== undefined && filters.courts.length > 0) {
    clauses.push(
      `(${filters.courts.map((court) => `court:${quoteCorpusValue(court)}`).join(" OR ")})`,
    );
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
