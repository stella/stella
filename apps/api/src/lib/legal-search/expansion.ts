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
  morphologyDictionaryKey,
  morphologyDictionaryPointerKey,
  parseExpansionDictionary,
  unpackExpansionForms,
} from "@/api/lib/legal-search/morphology/dictionary";
import type { MorphologyLanguage } from "@/api/lib/legal-search/morphology/stem";
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

/** Decompressed ceiling for one dictionary payload; measured builds are ~2 MB. */
const DICTIONARY_MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

/** Wall-clock bound on the two object reads a first use costs. */
const DICTIONARY_READ_TIMEOUT_MS = 30_000;

/**
 * How long an unavailable dictionary stays unavailable before another request
 * retries the read. Long enough that an outage cannot turn every search into
 * an object-store round trip, short enough that a first publish or a
 * recovered store starts serving without a restart.
 */
const DICTIONARY_UNAVAILABLE_TTL_MS = 60_000;

/** Structured events; swept for, so spelled once. */
const DICTIONARY_UNAVAILABLE =
  "case_law.search.expansion_dictionary_unavailable";
const DICTIONARY_LOADED = "case_law.search.expansion_dictionary_loaded";
const EXPANSION_SHADOW = "case_law.search.expansion_shadow";

type DictionaryLoad =
  | { entries: ReadonlyMap<string, string>; status: "loaded" }
  | { status: "unavailable" };

const UNAVAILABLE: DictionaryLoad = { status: "unavailable" };

const readDictionaryObject = async (key: string): Promise<Uint8Array> =>
  await readCorpusS3Bytes(key, AbortSignal.timeout(DICTIONARY_READ_TIMEOUT_MS));

/**
 * Resolve the pointer object to the payload key. The pointer is the one
 * mutable name in the layout, so a rebuild is a small write and a rollback is
 * the previous hash. Its contents choose which key is read, which is why the
 * hash shape is enforced rather than trusted.
 */
const readDictionaryPayload = async (
  language: MorphologyLanguage,
): Promise<string | null> => {
  const pointer = await readDictionaryObject(
    morphologyDictionaryPointerKey(language),
  );
  const contentHash = new TextDecoder().decode(pointer).trim();
  if (!isMorphologyDictionaryContentHash(contentHash)) {
    return null;
  }
  const payload = await readDictionaryObject(
    morphologyDictionaryKey(language, contentHash),
  );
  return await zstdDecompressToStringBounded(
    payload,
    DICTIONARY_MAX_DECOMPRESSED_BYTES,
  );
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
  if (read.value === null) {
    logger.warn(DICTIONARY_UNAVAILABLE, {
      language,
      reason: "malformed_pointer",
    });
    return UNAVAILABLE;
  }

  const { entries, skippedLines } = parseExpansionDictionary(read.value);
  if (entries.size === 0) {
    logger.warn(DICTIONARY_UNAVAILABLE, {
      language,
      reason: "empty_dictionary",
      skippedLines,
    });
    return UNAVAILABLE;
  }
  if (skippedLines > 0) {
    logger.warn(DICTIONARY_UNAVAILABLE, {
      language,
      reason: "malformed_lines",
      skippedLines,
      entries: entries.size,
    });
  }
  logger.info(DICTIONARY_LOADED, { language, entries: entries.size });
  return { entries, status: "loaded" };
};

type CacheEntry = {
  /** Null once the load succeeded: a loaded dictionary is immutable. */
  expiresAt: number | null;
  load: Promise<DictionaryLoad>;
};

const cache = new Map<MorphologyLanguage, CacheEntry>();

/**
 * The per-language lazy singleton. Concurrent first uses share one read, and
 * an unavailable result is remembered for a bounded window rather than
 * forever, so neither an outage nor a recovery needs a deploy.
 */
const dictionaryFor = async (
  language: MorphologyLanguage,
): Promise<DictionaryLoad> => {
  const cached = cache.get(language);
  if (cached && (cached.expiresAt === null || cached.expiresAt > Date.now())) {
    return await cached.load;
  }

  const load = loadDictionary(language);
  cache.set(language, {
    load,
    expiresAt: Date.now() + DICTIONARY_UNAVAILABLE_TTL_MS,
  });
  const result = await load;
  if (result.status === "loaded") {
    cache.set(language, { load, expiresAt: null });
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
  if (!isSurfaceForm(term)) {
    return [];
  }
  const folded = foldExpansionKey(term);
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
   * feature can reach at all.
   */
  countryScoped: boolean;
  executedQuery: string;
  expandedQuery: string;
  language: MorphologyLanguage | null;
};

/**
 * What the shadow event carries. Split from the emit so a test can assert
 * `sanitizeLogAttributes` keeps every key: the sanitizer drops payload-shaped
 * keys silently, and a dropped key here is an event that looks emitted and
 * measures nothing. Deriving the assertion from this function rather than
 * from a list of key names is what keeps the two from drifting.
 *
 * Both query strings are already reduced to quoted word tokens by the query
 * builder, and this endpoint searches published case law, not workspace
 * content.
 */
export const shadowExpansionAttributes = ({
  countryScoped,
  executedQuery,
  expandedQuery,
  language,
}: ShadowExpansionLog): LoggerAttributes => ({
  countryScoped,
  executedQuery,
  expandedQuery,
  expanded: expandedQuery !== executedQuery,
  language: language ?? "none",
});

/** Record what expansion would have done to a query that ran unexpanded. */
export const logShadowExpansion = (log: ShadowExpansionLog): void => {
  logger.info(EXPANSION_SHADOW, shadowExpansionAttributes(log));
};
