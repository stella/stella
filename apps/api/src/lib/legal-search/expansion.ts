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
import type { CorpusTermExpander } from "@/api/lib/legal-search/corpus-query";
import {
  foldExpansionKey,
  isMorphologyDictionaryContentHash,
  isSurfaceForm,
  MORPHOLOGY_DICTIONARY_MAX_BYTES,
  morphologyDictionaryKey,
  morphologyDictionaryPointerKey,
  parseExpansionDictionary,
  unpackExpansionForms,
} from "@/api/lib/legal-search/morphology/dictionary";
import type { MorphologyLanguage } from "@/api/lib/legal-search/morphology/stem";
import type { QueryExpansionMode } from "@/api/lib/legal-search/query-expansion-mode";
import type { LoggerAttributes } from "@/api/lib/observability/logger";
import { logger } from "@/api/lib/observability/logger";
import { readCorpusS3Bytes } from "@/api/lib/s3";

/**
 * Jurisdictions the corpus index serves, and the language whose dictionary
 * their text is expanded against. `null` means the jurisdiction is served
 * without expansion.
 *
 * Slovak resolves to `null` in phase 1: the stemmer exists, but no Slovak
 * dictionary is published yet, and pointing SVK at a language with no payload
 * would make every Slovak search pay a pointer read that can only miss.
 * Publishing the dictionary and flipping this one entry enables it.
 *
 * The EU index carries 24 languages under one jurisdiction, so a single
 * dictionary could not be chosen for it at all.
 */
const EXPANSION_LANGUAGE_BY_JURISDICTION = {
  CZE: "cs",
  EU: null,
  POL: "pl",
  SVK: null,
} as const satisfies Record<string, MorphologyLanguage | null>;

type ExpansionJurisdiction = keyof typeof EXPANSION_LANGUAGE_BY_JURISDICTION;

const isExpansionJurisdiction = (
  value: string,
): value is ExpansionJurisdiction =>
  Object.hasOwn(EXPANSION_LANGUAGE_BY_JURISDICTION, value);

/**
 * Which language a request's jurisdiction expands against, or null for no
 * expansion. An unscoped search (no country: the index pattern spans every
 * jurisdiction) resolves to null, because no one language describes its text.
 * An unrecognised jurisdiction resolves to null for the same reason; this
 * lookup's miss is the documented phase-1 scope, not a defect to report.
 */
export const expansionLanguageForJurisdiction = (
  country: string | undefined,
): MorphologyLanguage | null => {
  if (country === undefined) {
    return null;
  }
  const jurisdiction = country.toUpperCase();
  return isExpansionJurisdiction(jurisdiction)
    ? EXPANSION_LANGUAGE_BY_JURISDICTION[jurisdiction]
    : null;
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

/** Structured events; swept for, so spelled once. */
const DICTIONARY_UNAVAILABLE =
  "case_law.search.expansion_dictionary_unavailable";
const DICTIONARY_LOADED = "case_law.search.expansion_dictionary_loaded";
const EXPANSION_SHADOW = "case_law.search.expansion_shadow";

type DictionaryLoad =
  | { entries: ReadonlyMap<string, string>; status: "loaded" }
  | { status: "unavailable" };

const UNAVAILABLE: DictionaryLoad = { status: "unavailable" };

/** Why a resolve produced no dictionary, for the warning's `reason`. */
type DictionaryRejection = "content_hash_mismatch" | "malformed_pointer";

type DictionaryPayload =
  | { payload: string; status: "read" }
  | { reason: DictionaryRejection; status: "rejected" };

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
 */
const readDictionaryPayload = async (
  language: MorphologyLanguage,
): Promise<DictionaryPayload> => {
  const deadline = AbortSignal.timeout(DICTIONARY_RESOLVE_TIMEOUT_MS);
  const pointer = await readCorpusS3Bytes(
    morphologyDictionaryPointerKey(language),
    deadline,
  );
  const contentHash = new TextDecoder().decode(pointer).trim();
  if (!isMorphologyDictionaryContentHash(contentHash)) {
    return { reason: "malformed_pointer", status: "rejected" };
  }

  const compressed = await readCorpusS3Bytes(
    morphologyDictionaryKey(language, contentHash),
    deadline,
  );
  const payload = await zstdDecompressToStringBounded(
    compressed,
    MORPHOLOGY_DICTIONARY_MAX_BYTES,
  );
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(payload);
  if (hasher.digest("hex") !== contentHash) {
    return { reason: "content_hash_mismatch", status: "rejected" };
  }
  return { payload, status: "read" };
};

const loadDictionary = async (
  language: MorphologyLanguage,
): Promise<DictionaryLoad> => {
  const read = await Result.tryPromise({
    try: async () => await readDictionaryPayload(language),
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
  if (read.value.status === "rejected") {
    logger.warn(DICTIONARY_UNAVAILABLE, {
      language,
      reason: read.value.reason,
    });
    return UNAVAILABLE;
  }

  const { collidedKeys, entries, skippedLines } = parseExpansionDictionary(
    read.value.payload,
  );
  if (entries.size === 0) {
    logger.warn(DICTIONARY_UNAVAILABLE, {
      language,
      reason: "empty_dictionary",
      skippedLines,
    });
    return UNAVAILABLE;
  }
  if (skippedLines > 0 || collidedKeys > 0) {
    logger.warn(DICTIONARY_UNAVAILABLE, {
      language,
      reason: "degraded_dictionary",
      skippedLines,
      collidedKeys,
      entries: entries.size,
    });
  }
  logger.info(DICTIONARY_LOADED, {
    language,
    entries: entries.size,
    collidedKeys,
  });
  return { entries, status: "loaded" };
};

type CacheEntry = {
  expiresAt: number;
  load: Promise<DictionaryLoad>;
};

const cache = new Map<MorphologyLanguage, CacheEntry>();
/** The last payload that parsed, per language; a failed refresh falls back here. */
const lastLoaded = new Map<MorphologyLanguage, ReadonlyMap<string, string>>();

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
const dictionaryFor = async (
  language: MorphologyLanguage,
): Promise<DictionaryLoad> => {
  const cached = cache.get(language);
  if (cached && cached.expiresAt > Date.now()) {
    return await cached.load;
  }

  const load = (async (): Promise<DictionaryLoad> => {
    const result = await loadDictionary(language);
    if (result.status === "loaded") {
      lastLoaded.set(language, result.entries);
      return result;
    }
    const previous = lastLoaded.get(language);
    return previous === undefined
      ? result
      : { entries: previous, status: "loaded" };
  })();

  // Deduplicates concurrent callers while the read is in flight; corrected to
  // the retry window below if it turns out there is nothing to serve.
  cache.set(language, {
    load,
    expiresAt: Date.now() + DICTIONARY_REFRESH_TTL_MS,
  });
  const result = await load;
  if (result.status === "unavailable") {
    cache.set(language, {
      load,
      expiresAt: Date.now() + DICTIONARY_UNAVAILABLE_TTL_MS,
    });
  }
  return result;
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
  // Fold first, then test the shape. The fold canonicalises and strips
  // combining marks, so a decomposed `žalobě` (routine from extracted PDFs and
  // from macOS keyboards) is judged as the word it is rather than rejected for
  // the marks it carries. Digits and punctuation survive the fold, so the
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

/**
 * The expander for a request, or null when this request expands nothing.
 * Null covers an unscoped or unsupported jurisdiction and an unavailable
 * dictionary alike, so the caller has one branch rather than a mode matrix.
 */
export const corpusTermExpander = async (
  country: string | undefined,
): Promise<CorpusTermExpander | null> => {
  const language = expansionLanguageForJurisdiction(country);
  if (language === null) {
    return null;
  }
  const dictionary = await dictionaryFor(language);
  switch (dictionary.status) {
    case "unavailable": {
      return null;
    }
    case "loaded": {
      return (term) => expandTermWith(dictionary.entries, term);
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
  /** Quoted leaves the expanded query carries; equals `baseLeaves` when inert. */
  expandedLeaves: number;
  language: MorphologyLanguage | null;
  /** Quoted leaves before expansion: one per token the reader typed. */
  baseLeaves: number;
  /** Why this request expanded nothing, or "expanded" when it did. */
  reach: "expanded" | "no_dictionary" | "unsupported_jurisdiction";
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
  expandedLeaves,
  language,
  reach,
}: ShadowExpansionLog): LoggerAttributes => ({
  baseLeaves,
  countryScoped,
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

type ResolveExpandedQueryOptions = {
  /** Assemble the clause, with the expander when one is supplied. */
  build: (expand?: CorpusTermExpander) => string | null;
  jurisdiction: string | undefined;
  mode: QueryExpansionMode;
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
 */
export const resolveExpandedCorpusQuery = async ({
  build,
  jurisdiction,
  mode,
}: ResolveExpandedQueryOptions): Promise<string | null> => {
  const baseQuery = build();
  if (mode === "off" || baseQuery === null) {
    return baseQuery;
  }

  const countryScoped = jurisdiction !== undefined;
  const language = expansionLanguageForJurisdiction(jurisdiction);
  const expand =
    language === null ? null : await corpusTermExpander(jurisdiction);

  // A request that reaches no dictionary still reports, or the reach metrics
  // would only ever describe the traffic expansion already covers.
  if (expand === null) {
    if (mode === "shadow") {
      const baseLeaves = countLeaves(baseQuery);
      logShadowExpansion({
        baseLeaves,
        countryScoped,
        expandedLeaves: baseLeaves,
        language,
        reach: language === null ? "unsupported_jurisdiction" : "no_dictionary",
      });
    }
    return baseQuery;
  }

  // Both builds tokenize the same text, so this is null only when `baseQuery`
  // already was; returning the base query keeps the branch total anyway.
  const expandedQuery = build(expand);
  if (expandedQuery === null) {
    return baseQuery;
  }

  switch (mode) {
    case "on": {
      return expandedQuery;
    }
    case "shadow": {
      logShadowExpansion({
        baseLeaves: countLeaves(baseQuery),
        countryScoped,
        expandedLeaves: countLeaves(expandedQuery),
        language,
        reach: "expanded",
      });
      return baseQuery;
    }
    default: {
      return mode satisfies never;
    }
  }
};
