/**
 * Morphological query expansion for the case-law corpus index.
 *
 * Czech and Polish inflect heavily, so a reader searching `nájemné` misses
 * the judgments that write `nájemného`. Each term the reader types becomes an
 * OR group of that word's other surface forms, AND-ed with the rest of the
 * query exactly as before.
 *
 * The stemmer never runs here. Query text arrives folded, decomposed, and
 * lowercased in whatever combination the reader's keyboard produced, and the
 * suffix tables are written over accented, precomposed characters — stemming
 * that input mis-stems a measurable fraction of it. Instead an offline build
 * stems the accented corpus vocabulary once (see
 * `scripts/build-expansion-dictionary.ts`) and query time is a Map lookup on
 * the folded form.
 *
 * Everything here degrades to the identity: a missing dictionary, an
 * unreachable bucket, a term the guards reject, or a budget that has run out
 * all produce the query the reader would have gotten anyway. Expansion is
 * allowed to add recall and is never allowed to remove it or to fail a search.
 */

import { Result } from "better-result";

import { zstdDecompressToStringBounded } from "@/api/lib/compression";
import { detached } from "@/api/lib/detached";
import {
  corpusFreeTextClause,
  type CorpusTermExpander,
} from "@/api/lib/legal-search/corpus-query";
import { corpusMorphologyLanguage } from "@/api/lib/legal-search/morphology/corpus-language";
import {
  type ExpansionDictionaryIdentity,
  foldExpansionKey,
  isMorphologyDictionaryContentHash,
  isSurfaceForm,
  MORPHOLOGY_DICTIONARY_MAX_BYTES,
  morphologyDictionaryKey,
  morphologyDictionaryPointerKey,
  NO_EXPANSION_DICTIONARY_IDENTITY,
  parseExpansionDictionaryOffLoop,
  unpackExpansionForms,
} from "@/api/lib/legal-search/morphology/dictionary";
import type { MorphologyLanguage } from "@/api/lib/legal-search/morphology/stem";
import type { QueryExpansionMode } from "@/api/lib/legal-search/query-expansion-mode";
import type { LoggerAttributes } from "@/api/lib/observability/logger";
import { logger } from "@/api/lib/observability/logger";
import { readCorpusS3BytesBounded } from "@/api/lib/s3";

/**
 * Whether a language's dictionary payload exists to be read.
 *
 * Expansion needs one and stemming does not, which is the whole difference
 * between this and `corpusMorphologyLanguage`: most stemmable languages have
 * no published dictionary, so pointing their searches at one would pay a
 * pointer read that can only miss. Publishing the payload and flipping that
 * language's entry enables expansion for it.
 *
 * Total, so a language added to the stemmer has to answer this too rather
 * than silently inheriting a dictionary it has none of.
 */
const EXPANSION_DICTIONARY = {
  cs: "published",
  da: "unpublished",
  de: "unpublished",
  el: "unpublished",
  en: "unpublished",
  es: "unpublished",
  et: "unpublished",
  fi: "unpublished",
  fr: "unpublished",
  ga: "unpublished",
  hu: "unpublished",
  it: "unpublished",
  lt: "unpublished",
  nl: "unpublished",
  pl: "published",
  pt: "unpublished",
  ro: "unpublished",
  sk: "unpublished",
  sv: "unpublished",
} as const satisfies Record<MorphologyLanguage, "published" | "unpublished">;

/**
 * Which language a request's jurisdiction expands against, or null for no
 * expansion.
 *
 * The jurisdiction's language is `corpusMorphologyLanguage`, the one map the
 * projection stems against as well, so the two sides cannot disagree about
 * what a jurisdiction is written in. Only the dictionary question is answered
 * here. An unscoped search (no country: the index pattern spans every
 * jurisdiction) resolves to null there, because no one language describes its
 * text, and so does a jurisdiction with no single language of its own.
 */
export const expansionLanguageForJurisdiction = (
  country: string | undefined,
): MorphologyLanguage | null => {
  const language = corpusMorphologyLanguage(country);
  if (language === null) {
    return null;
  }
  return EXPANSION_DICTIONARY[language] === "published" ? language : null;
};

/**
 * Hard floor on the length of a term worth expanding, in code points.
 *
 * Not `min(3, term.length)`: a two-character term shares its whole length
 * with far too much of the vocabulary, and the shorter-of rule let Polish
 * two-letter words expand into groups that had nothing to do with them.
 */
const MIN_EXPANDABLE_TERM_LENGTH = 3;

/**
 * Longest common prefix a form must share with the typed term, in code points
 * of the folded spelling.
 *
 * A stem bucket is only as good as the stemmer, and a light stemmer
 * occasionally over-strips: `veci` and `vek` reduce to the same stem without
 * being the same word. Requiring three shared leading characters contains
 * every incoherent bucket the corpus build reported, and costs nothing for
 * real inflection, which varies at the end of a word rather than the start.
 */
const MIN_FORM_COMMON_PREFIX = 3;

/**
 * Wall-clock bound on resolving a dictionary, pointer read and payload read
 * together. One deadline for the whole operation, not one per object: two
 * sequential 30s bounds would let a stalled payload read keep the first search
 * after startup waiting for a minute, including a `shadow` request that goes
 * on to execute the unexpanded query anyway.
 */
const DICTIONARY_RESOLVE_TIMEOUT_MS = 30_000;

/**
 * How long an unavailable dictionary stays unavailable before another request
 * retries the read. Long enough that an outage cannot turn every search into
 * an object-store round trip, short enough that a first publish or a
 * recovered store starts serving without a restart.
 */
const DICTIONARY_UNAVAILABLE_TTL_MS = 60_000;

/**
 * How long a loaded dictionary is served before the pointer is rechecked.
 *
 * A loaded payload is immutable, but the pointer naming it is not: caching the
 * payload forever would make a rebuild or a rollback reach only replicas that
 * restart afterwards, so identical requests would get different queries from
 * warm and new instances indefinitely. A failed refresh keeps serving the
 * payload that last worked rather than falling back to no expansion.
 */
const DICTIONARY_REFRESH_TTL_MS = 15 * 60_000;

/** A pointer holds one sha256 hex string; anything larger is not a pointer. */
const POINTER_MAX_BYTES = 1024;

/** Structured events; swept for, so spelled once. */
const DICTIONARY_UNAVAILABLE =
  "case_law.search.expansion_dictionary_unavailable";
const DICTIONARY_DEGRADED = "case_law.search.expansion_dictionary_degraded";
const DICTIONARY_LOADED = "case_law.search.expansion_dictionary_loaded";
const EXPANSION_SHADOW = "case_law.search.expansion_shadow";

type LoadedDictionary = {
  /** sha256 of the payload: which build this replica is answering from. */
  contentHash: string;
  entries: ReadonlyMap<string, string>;
};

/** Enough hash to tell two builds apart in telemetry, without the other 52. */
const shortHash = (contentHash: string): string => contentHash.slice(0, 12);

type DictionaryLoad =
  | (LoadedDictionary & { status: "loaded" })
  | { status: "unavailable" };

const UNAVAILABLE: DictionaryLoad = { status: "unavailable" };

/** Why a resolve produced no dictionary, for the warning's `reason`. */
type DictionaryRejection = "content_hash_mismatch" | "malformed_pointer";

type DictionaryPayload =
  | { contentHash: string; payload: string; status: "read" }
  | { reason: DictionaryRejection; status: "rejected" }
  | { status: "unchanged" };

/**
 * Resolve the pointer object to the payload, under one shared deadline.
 *
 * The pointer is the layout's only mutable name, so a rebuild is a small write
 * and a rollback is the previous hash. Two properties are enforced rather than
 * trusted, because the pointer's contents choose which key is read: its shape
 * must be a sha256 hex string, and the bytes found at the key it names must
 * actually hash to it. Without the second check an overwritten or mispublished
 * object at a content-addressed key would be served as though it were the
 * addressed content, which is the whole guarantee the layout exists to give.
 *
 * `residentHash` short-circuits the common case. A refresh exists to notice a
 * pointer that moved, and most do not: re-fetching, decompressing, hashing and
 * reparsing a payload of up to the ceiling every cycle would spend recurring
 * object-store traffic and synchronous event-loop time to rebuild a map
 * identical to the one already in memory. Only the pointer is read unless it
 * names something new.
 */
const readDictionaryPayload = async (
  language: MorphologyLanguage,
  residentHash: string | undefined,
): Promise<DictionaryPayload> => {
  const deadline = AbortSignal.timeout(DICTIONARY_RESOLVE_TIMEOUT_MS);
  const pointer = await readCorpusS3BytesBounded({
    key: morphologyDictionaryPointerKey(language),
    maxBytes: POINTER_MAX_BYTES,
    signal: deadline,
  });
  const contentHash = new TextDecoder().decode(pointer).trim();
  if (!isMorphologyDictionaryContentHash(contentHash)) {
    return { reason: "malformed_pointer", status: "rejected" };
  }
  if (contentHash === residentHash) {
    return { status: "unchanged" };
  }

  // Bounded on the compressed transfer, not only on what it decodes to: the
  // decompression ceiling below would otherwise run after the whole body was
  // already resident.
  const compressed = await readCorpusS3BytesBounded({
    key: morphologyDictionaryKey(language, contentHash),
    maxBytes: MORPHOLOGY_DICTIONARY_MAX_BYTES,
    signal: deadline,
  });
  const payload = await zstdDecompressToStringBounded(
    compressed,
    MORPHOLOGY_DICTIONARY_MAX_BYTES,
  );
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(payload);
  if (hasher.digest("hex") !== contentHash) {
    return { reason: "content_hash_mismatch", status: "rejected" };
  }
  return { contentHash, payload, status: "read" };
};

const loadDictionary = async (
  language: MorphologyLanguage,
): Promise<DictionaryLoad> => {
  const resident = lastLoaded.get(language);
  const read = await Result.tryPromise({
    try: async () =>
      await readDictionaryPayload(language, resident?.contentHash),
    catch: (cause) => cause,
  });

  if (!Result.isOk(read)) {
    logger.warn(DICTIONARY_UNAVAILABLE, {
      language,
      reason: "read_failed",
      errorClass:
        read.error instanceof Error ? read.error.constructor.name : "unknown",
    });
    return UNAVAILABLE;
  }
  // The pointer still names what is already in memory; nothing was fetched.
  // Only reachable when a resident hash was passed in, so the fallback is
  // unreachable rather than a real state — but it keeps the branch total.
  if (read.value.status === "unchanged") {
    return resident === undefined
      ? UNAVAILABLE
      : { ...resident, status: "loaded" };
  }
  if (read.value.status === "rejected") {
    logger.warn(DICTIONARY_UNAVAILABLE, {
      language,
      reason: read.value.reason,
    });
    return UNAVAILABLE;
  }

  const { collidedKeys, entries, skippedLines } =
    await parseExpansionDictionaryOffLoop(read.value.payload);
  if (entries.size === 0) {
    logger.warn(DICTIONARY_UNAVAILABLE, {
      language,
      reason: "empty_dictionary",
      skippedLines,
    });
    return UNAVAILABLE;
  }
  // Its own event, not the unavailable one: this dictionary is being served.
  // Folding it into the unavailable event would make every alert on that name
  // count successful loads, and a handful of collided keys is the normal state
  // of a real dictionary (`rada`/`řada` is ordinary Czech), so the false
  // positives would be continuous rather than occasional.
  if (skippedLines > 0 || collidedKeys > 0) {
    logger.warn(DICTIONARY_DEGRADED, {
      language,
      skippedLines,
      collidedKeys,
      entries: entries.size,
    });
  }
  logger.info(DICTIONARY_LOADED, {
    language,
    entries: entries.size,
    collidedKeys,
    dictionaryHash: shortHash(read.value.contentHash),
  });
  return { contentHash: read.value.contentHash, entries, status: "loaded" };
};

type CacheEntry = {
  expiresAt: number;
  load: Promise<DictionaryLoad>;
};

const cache = new Map<MorphologyLanguage, CacheEntry>();
/** The last payload that parsed, per language; a failed refresh falls back here. */
const lastLoaded = new Map<MorphologyLanguage, LoadedDictionary>();
/**
 * Languages whose read is currently in flight. Distinct from the cache entry's
 * expiry, which is set to the future the moment a refresh starts: without this,
 * every request arriving during a refresh window sees a live entry and awaits
 * the pending read, so only the caller that happened to start the refresh got
 * the stale-serving fast path.
 */
const inFlight = new Set<MorphologyLanguage>();
/**
 * Languages whose most recent load resolved with nothing to serve. Tracked
 * rather than inferred from `lastLoaded` being empty: those two states look
 * identical from outside and mean opposite things — a replica still warming up
 * versus one that cannot read its dictionary at all. Conflating them would
 * report every persistent storage or configuration failure as a warm-up.
 */
const resolvedUnavailable = new Set<MorphologyLanguage>();

/**
 * The per-language lazy singleton. Concurrent uses share one read, a loaded
 * dictionary is rechecked against the pointer on a slow cycle, and an
 * unavailable one is retried on a fast one, so neither a rebuild, a rollback,
 * an outage, nor a recovery needs a deploy.
 *
 * A refresh that fails keeps serving the payload that last parsed: losing
 * expansion because object storage blipped would be a recall regression the
 * reader sees, where serving a slightly stale dictionary is not.
 */
// `async` only to satisfy the promise-returning convention; the body has no
// await, so the cache entry below is installed synchronously by the caller's
// own turn — which is what makes concurrent callers share this one read.
const beginRefresh = async (
  language: MorphologyLanguage,
): Promise<DictionaryLoad> => {
  inFlight.add(language);
  const load = (async (): Promise<DictionaryLoad> => {
    try {
      const result = await loadDictionary(language);
      if (result.status === "loaded") {
        lastLoaded.set(language, {
          contentHash: result.contentHash,
          entries: result.entries,
        });
        resolvedUnavailable.delete(language);
        return result;
      }
      resolvedUnavailable.add(language);
      const previous = lastLoaded.get(language);
      if (previous !== undefined) {
        return { ...previous, status: "loaded" };
      }
      // Nothing to serve at all: retry on the fast cycle rather than the slow
      // one. Re-read the entry rather than closing over the promise being built.
      const entry = cache.get(language);
      if (entry !== undefined) {
        cache.set(language, {
          load: entry.load,
          expiresAt: Date.now() + DICTIONARY_UNAVAILABLE_TTL_MS,
        });
      }
      return result;
    } finally {
      // `finally`, not a trailing statement: a leaked marker would pin the
      // language to its stale payload for the life of the process.
      inFlight.delete(language);
    }
  })();

  // Set before anyone awaits, so concurrent callers share this one read.
  cache.set(language, {
    load,
    expiresAt: Date.now() + DICTIONARY_REFRESH_TTL_MS,
  });
  return load;
};

const dictionaryFor = async (
  language: MorphologyLanguage,
): Promise<DictionaryLoad> => {
  const previous = lastLoaded.get(language);

  // A read in flight must not block a request that can already be answered.
  // This is checked before the cache entry, because a refresh installs its
  // entry with a future expiry the instant it starts.
  if (previous !== undefined && inFlight.has(language)) {
    return { ...previous, status: "loaded" };
  }

  const cached = cache.get(language);
  if (cached && cached.expiresAt > Date.now()) {
    return await cached.load;
  }

  const refresh = beginRefresh(language);
  if (previous === undefined) {
    // Cold: there is nothing to answer with, so this caller waits for the read.
    return await refresh;
  }

  // Warm: answer from the payload already in memory and let the refresh finish
  // behind the request. Awaiting here would make every search that arrives
  // during a refresh window inherit the read's latency — up to the full resolve
  // deadline when object storage is slow — which is exactly the stall the
  // fallback exists to prevent.
  detached(refresh, "legal-search.expansion-dictionary-refresh");
  return { ...previous, status: "loaded" };
};

/**
 * Shared leading characters, counted in code points rather than UTF-16 units
 * so a surrogate pair is one character on both sides of the comparison.
 */
const commonPrefixLength = (left: string, right: string): number => {
  const a = Array.from(left);
  const b = Array.from(right);
  const bound = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < bound && a[shared] === b[shared]) {
    shared += 1;
  }
  return shared;
};

/**
 * The extra forms one typed term contributes, given a dictionary.
 *
 * Exported for tests and for the offline coherence report; the request path
 * reaches it through `corpusTermExpander`. Rejects, in order: anything that is
 * not a bare word (digits, identifiers, and every citation fragment the
 * tokenizer can produce fail this), anything shorter than the floor, a term
 * with no bucket, and any form that does not share a prefix with what the
 * reader typed.
 */
export const expandTermWith = (
  entries: ReadonlyMap<string, string>,
  term: string,
): readonly string[] => {
  // Fold first, then test the shape. The fold decomposes and removes the
  // marks, so a decomposed `žalobě` (routine from extracted PDFs and from
  // macOS keyboards) is judged as the word it is rather than rejected for the
  // marks it carries. Digits and punctuation survive the fold, so the
  // letters-only rule still excludes every identifier it excluded before.
  const folded = foldExpansionKey(term);
  if (!isSurfaceForm(folded)) {
    return [];
  }
  if (Array.from(folded).length < MIN_EXPANDABLE_TERM_LENGTH) {
    return [];
  }
  const packed = entries.get(folded);
  if (packed === undefined) {
    return [];
  }

  const extras: string[] = [];
  for (const form of unpackExpansionForms(packed)) {
    const foldedForm = foldExpansionKey(form);
    if (foldedForm === folded) {
      continue;
    }
    if (commonPrefixLength(folded, foldedForm) < MIN_FORM_COMMON_PREFIX) {
      continue;
    }
    extras.push(form);
  }
  return extras;
};

type ResolvedExpander = {
  /** Which payload answered, so telemetry can show replicas converging. */
  contentHash: string;
  expand: CorpusTermExpander;
};

/**
 * Whether a caller may wait for a cold dictionary.
 *
 * `on` must: the query it returns depends on the dictionary, so there is
 * nothing to serve until the read finishes. `shadow` must not: it executes the
 * unexpanded query whatever happens, so waiting on object storage would add
 * that latency to a search purely to observe it — and on a cold replica with a
 * slow store that is the full resolve deadline, paid by every request sharing
 * the load. An observational mode that can slow the request path is not one
 * anybody can safely leave on.
 */
type ExpanderAvailability = "await_cold_load" | "resident_only";

/**
 * The expander for a request, or null when this request expands nothing.
 * Null covers an unscoped or unsupported jurisdiction, an unavailable
 * dictionary, and (under `resident_only`) one not yet in memory, so the caller
 * has one branch rather than a mode matrix.
 */
const corpusTermExpander = async (
  country: string | undefined,
  availability: ExpanderAvailability,
): Promise<ResolvedExpander | null> => {
  const language = expansionLanguageForJurisdiction(country);
  if (language === null) {
    return null;
  }
  if (availability === "resident_only" && !lastLoaded.has(language)) {
    // Warm it for the requests after this one, off the request path.
    detached(dictionaryFor(language), "legal-search.expansion-dictionary-warm");
    return null;
  }
  const dictionary = await dictionaryFor(language);
  switch (dictionary.status) {
    case "unavailable": {
      return null;
    }
    case "loaded": {
      return {
        contentHash: dictionary.contentHash,
        expand: (term) => expandTermWith(dictionary.entries, term),
      };
    }
    default: {
      return dictionary satisfies never;
    }
  }
};

type ShadowExpansionLog = {
  /**
   * Whether the reader scoped the search to one jurisdiction. Unscoped
   * searches fan out across every index and never expand, so the ratio of
   * scoped to unscoped traffic is what says how much of the corpus this
   * feature can reach at all. Emitted for requests that expanded nothing too,
   * or the ratio would be one by construction.
   */
  countryScoped: boolean;
  /**
   * Short hash of the payload that answered, or "none". Replicas serving
   * different builds is what makes a paginated `on` query inconsistent, so the
   * rollout has to be able to see convergence before that mode is considered.
   */
  dictionaryHash: string;
  /** Free-text leaves after expansion; equals `baseLeaves` when nothing fired. */
  expandedLeaves: number;
  language: MorphologyLanguage | null;
  /**
   * Free-text leaves before expansion: one per token the reader typed. Counted
   * on the free-text clause alone, never on the assembled query, whose filter
   * clauses (`court:"…"`, `language:"…"`, a date range) are quoted leaves the
   * reader did not type and would dilute the multiplier this measures.
   */
  baseLeaves: number;
  /**
   * What actually happened, not what was available. `expanded` means leaves
   * were added; a loaded dictionary that matched no term, lost every form to
   * the guards, or ran out of budget reports `dictionary_inert`, so grouping
   * by this field cannot overstate how often expansion fires.
   */
  reach:
    | "dictionary_inert"
    | "dictionary_warming"
    | "expanded"
    | "no_dictionary"
    | "unsupported_jurisdiction";
};

/**
 * What the shadow event carries: counts, never text.
 *
 * The query strings are deliberately absent. They are the reader's own words,
 * and a case-law search can carry a client name, a party, or the shape of a
 * legal strategy; copying them into INFO telemetry, the stderr mirror, and any
 * configured OTLP sink would be new exposure that nothing in the request path
 * creates today. `sanitizeLogAttributes` would not have redacted them either,
 * since neither key is payload-shaped. Leaf counts answer what the rollout
 * needs to know (how often expansion fires, how much it widens a query, and
 * how much traffic it can reach at all) and reconstruct nothing.
 *
 * Split from the emit so a test can assert the sanitizer keeps every key: it
 * drops keys silently, and a dropped key is an event that looks emitted and
 * measures nothing. The assertion derives from this function rather than from
 * a hand-kept list of names, so the two cannot drift.
 */
export const shadowExpansionAttributes = ({
  baseLeaves,
  countryScoped,
  dictionaryHash,
  expandedLeaves,
  language,
  reach,
}: ShadowExpansionLog): LoggerAttributes => ({
  baseLeaves,
  countryScoped,
  dictionaryHash,
  expandedLeaves,
  addedLeaves: expandedLeaves - baseLeaves,
  language: language ?? "none",
  reach,
});

/** Record what expansion would have done to a query that ran unexpanded. */
export const logShadowExpansion = (log: ShadowExpansionLog): void => {
  logger.info(EXPANSION_SHADOW, shadowExpansionAttributes(log));
};

/**
 * Quoted leaves in an assembled clause: quote characters that open a span,
 * counted outside one. Cheap, and it needs no access to the token stream.
 */
const countLeaves = (clause: string): number => {
  let leaves = 0;
  let index = 0;
  let inQuotes = false;
  while (index < clause.length) {
    const char = clause.charAt(index);
    if (inQuotes) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === '"') {
        inQuotes = false;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      leaves += 1;
    }
    index += 1;
  }
  return leaves;
};

/**
 * Leaves the reader's own text contributes, with or without expansion. Built
 * from the free-text clause rather than measured on the assembled query, so
 * filter clauses never enter the count.
 */
const freeTextLeaves = (text: string, expand?: CorpusTermExpander): number => {
  const clause = corpusFreeTextClause(text, { expand });
  return clause === null ? 0 : countLeaves(clause);
};

/**
 * Why a request that routed to a supported language still got no expander.
 * Distinguishing "not loaded yet" from "would not load" matters to the rollout:
 * the first is a cold replica that will be answering normally in a moment, the
 * second is an operational problem.
 */
const expanderMissReach = (
  language: MorphologyLanguage | null,
): "dictionary_warming" | "no_dictionary" | "unsupported_jurisdiction" => {
  if (language === null) {
    return "unsupported_jurisdiction";
  }
  return resolvedUnavailable.has(language)
    ? "no_dictionary"
    : "dictionary_warming";
};

type ResolveExpandedQueryOptions = {
  /** Assemble the clause, with the expander when one is supplied. */
  build: (expand?: CorpusTermExpander) => string | null;
  jurisdiction: string | undefined;
  mode: QueryExpansionMode;
  /** The reader's free text, for metrics that must exclude filter clauses. */
  text: string;
};

/**
 * The engine query, and which dictionary produced it.
 *
 * The identity travels with the query rather than beside it: a caller that
 * paginates must write it into the cursor, and one that resolved a query it
 * could pair with any identity is the mismatch the cursor exists to catch.
 * `empty` is the free text carrying no searchable term, where callers return
 * an empty page without querying the engine.
 */
export type ExpandedCorpusQuery =
  | { dictionary: ExpansionDictionaryIdentity; query: string; type: "query" }
  | { type: "empty" };

/** The pre-expansion query, which no dictionary was applied to. */
const unexpandedCorpusQuery = (query: string): ExpandedCorpusQuery => ({
  dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
  query,
  type: "query",
});

type RewrittenCorpusQueryOptions = {
  baseQuery: string;
  contentHash: string;
  expandedQuery: string;
};

/**
 * What a rewrite reports as the dictionary behind it.
 *
 * A payload that changed nothing did not rank this query: the bytes sent to
 * the engine are the pre-expansion ones, so the page is continuable by any
 * request that builds the same pre-expansion query. Naming the payload here
 * instead would expire a live cursor on the next rebuild over a dictionary
 * that cannot affect this query either way.
 *
 * Both sides are the assembled clause, so the comparison sees the generation's
 * own leaves (a summary field, the stem fields) exactly as the engine will.
 * Only the expansion leaves can differ between them, which is what makes
 * equality here mean "the dictionary added nothing" rather than "the two
 * builds happened to agree".
 *
 * Exported for the test that pins this rule; the request path reaches it
 * through `resolveExpandedCorpusQuery`, which is the only caller.
 */
export const rewrittenCorpusQuery = ({
  baseQuery,
  contentHash,
  expandedQuery,
}: RewrittenCorpusQueryOptions): ExpandedCorpusQuery =>
  expandedQuery === baseQuery
    ? unexpandedCorpusQuery(baseQuery)
    : {
        dictionary: { contentHash, type: "dictionary" },
        query: expandedQuery,
        type: "query",
      };

/**
 * The query a corpus-index search sends to the engine, under the deployment's
 * expansion mode.
 *
 * Both case-law corpus-index boundaries (the public search handler and the
 * shared provider) resolve through here, for the same reason both assemble
 * through `caseLawCorpusQuery`: a rollout flag applied at one boundary and not
 * the other is two answers to what the engine sees, which is exactly what the
 * shared builder exists to prevent.
 *
 * `off` never resolves a dictionary and returns the byte-identical
 * pre-expansion query. `shadow` builds both, records the comparison, and
 * executes the unexpanded one. `on` executes the expanded one. Every failure
 * inside resolves to the unexpanded query, so a search never depends on the
 * dictionary being reachable.
 *
 * A query's ranking is only comparable with another built the same way, which
 * is why every branch reports the dictionary it applied — the payload's hash
 * under `on` when it rewrote the query, and `none` wherever the unexpanded
 * query ran, including a mode that expands nothing, a jurisdiction with no
 * dictionary, a payload that could not be read, and one that matched nothing
 * the reader typed. `corpus-search-cursor` pins that answer into the page
 * boundary so a continuation cannot be served from a different result set.
 *
 * Quoted phrases are never rewritten (`corpus-query` holds the policy), so a
 * phrase keeps matching the exact surface forms the reader typed under every
 * mode.
 */
export const resolveExpandedCorpusQuery = async ({
  build,
  jurisdiction,
  mode,
  text,
}: ResolveExpandedQueryOptions): Promise<ExpandedCorpusQuery> => {
  const baseQuery = build();
  if (baseQuery === null) {
    return { type: "empty" };
  }
  if (mode === "off") {
    return unexpandedCorpusQuery(baseQuery);
  }

  const countryScoped = jurisdiction !== undefined;
  const language = expansionLanguageForJurisdiction(jurisdiction);
  const expand =
    language === null
      ? null
      : await corpusTermExpander(
          jurisdiction,
          mode === "shadow" ? "resident_only" : "await_cold_load",
        );

  // A request that reaches no dictionary still reports, or the reach metrics
  // would only ever describe the traffic expansion already covers.
  if (expand === null) {
    if (mode === "shadow") {
      const baseLeaves = freeTextLeaves(text);
      logShadowExpansion({
        baseLeaves,
        countryScoped,
        dictionaryHash: "none",
        expandedLeaves: baseLeaves,
        language,
        reach: expanderMissReach(language),
      });
    }
    return unexpandedCorpusQuery(baseQuery);
  }

  // Both builds tokenize the same text, so this is null only when `baseQuery`
  // already was; returning the base query keeps the branch total anyway.
  const expandedQuery = build(expand.expand);
  if (expandedQuery === null) {
    return unexpandedCorpusQuery(baseQuery);
  }

  switch (mode) {
    case "on": {
      // The identity names what built the query, not what happened to be
      // loaded while it was built.
      return rewrittenCorpusQuery({
        baseQuery,
        contentHash: expand.contentHash,
        expandedQuery,
      });
    }
    case "shadow": {
      const baseLeaves = freeTextLeaves(text);
      const expandedLeaves = freeTextLeaves(text, expand.expand);
      logShadowExpansion({
        baseLeaves,
        countryScoped,
        dictionaryHash: shortHash(expand.contentHash),
        expandedLeaves,
        language,
        // A dictionary that loaded but matched nothing, lost every form to the
        // guards, or ran out of budget did not expand this query.
        reach: expandedLeaves > baseLeaves ? "expanded" : "dictionary_inert",
      });
      return unexpandedCorpusQuery(baseQuery);
    }
    default: {
      return mode satisfies never;
    }
  }
};
