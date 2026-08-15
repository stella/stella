/**
 * On-disk and in-memory shape of a morphological expansion dictionary.
 *
 * One module owns the object key, the serialized format, and the fold that
 * turns a surface form into a lookup key, because the offline builder and the
 * query-time loader are two sides of the same contract: a builder that
 * serialized what the loader does not parse would degrade search silently
 * rather than fail.
 *
 * The dictionary is derived from corpus text, so its contents are untrusted
 * input to the query builder. Every value is filtered to letters here, at
 * build time and again at load time; the query builder additionally quotes
 * what it emits. Neither layer is allowed to be the only one.
 */

import { stripDiacritics } from "@stll/text-normalize";

import type { MorphologyLanguage } from "@/api/lib/legal-search/morphology/stem";

const KEY_PREFIX = "legal-corpus/morphology";

/** sha256 hex, the only shape a dictionary payload is addressed by. */
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * A surface form is letters and nothing else. Digits, punctuation, and
 * whitespace are excluded at the source: a form that carried them could not
 * be a word the stemmer bucketed, and letters-only is what lets the packed
 * value use a comma as its separator without an escape rule.
 */
const SURFACE_FORM_PATTERN = /^\p{L}+$/u;

/** Separator between packed surface forms, in the file and in memory alike. */
const FORM_SEPARATOR = ",";

/** Fields per serialized line: stem, packed forms, bucket document frequency. */
const LINE_FIELDS = 3;

/**
 * A bucket with one member expands to nothing, so it is dropped at build
 * time; the loader rejects one that reappears rather than storing a
 * self-expansion no caller can use.
 */
const MIN_FORMS_PER_BUCKET = 2;

/**
 * Surface forms kept per stem, by descending corpus frequency. Four is what
 * the corpus measurement supported: the tail past it is dominated by rare
 * inflections that widen the query without adding recall.
 */
export const MAX_FORMS_PER_BUCKET = 4;

/**
 * Decompressed ceiling for one payload. Shared with the builder, which refuses
 * to publish past it: a dictionary the loader would reject is worse than no
 * dictionary, because the pointer advances and every replica silently falls
 * back to unexpanded search until an operator notices.
 */
export const MORPHOLOGY_DICTIONARY_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Where the pointer for a language lives. The payload is content-addressed
 * and therefore immutable; this object is the one mutable name, holding the
 * current payload's content hash so a rebuild is a single small write and a
 * rollback is the previous hash.
 */
export const morphologyDictionaryPointerKey = (
  language: MorphologyLanguage,
): string => `${KEY_PREFIX}/language=${language}/current.txt`;

/**
 * Where a payload lives. Callers must pass a hash that
 * `isMorphologyDictionaryContentHash` accepted: the value reaches this
 * function from object storage, and an unconstrained string here would let a
 * pointer's contents choose which key is read.
 */
export const morphologyDictionaryKey = (
  language: MorphologyLanguage,
  contentHash: string,
): string =>
  `${KEY_PREFIX}/language=${language}/${contentHash}/expansion.tsv.zst`;

export const isMorphologyDictionaryContentHash = (value: string): boolean =>
  CONTENT_HASH_PATTERN.test(value);

/**
 * Lookup key for a surface form: NFC, lowercased, then diacritics stripped.
 *
 * Keys are folded, values are not. The corpus is written with diacritics and
 * queries frequently are not, so folding the key is what lets "skody" reach
 * the bucket "škody" sits in. The forms the query emits keep their accents,
 * because the engine folds its own query terms and an accented form matches
 * strictly more index terms than its folded spelling would.
 *
 * The stemmer deliberately runs the other way round (fold after stemming),
 * which is why it is never called here: this fold destroys exactly the
 * characters the suffix tables are written over.
 */
export const foldExpansionKey = (term: string): string =>
  stripDiacritics(term.normalize("NFC").toLowerCase());

export type ExpansionBucket = {
  /** Corpus document frequency summed over the bucket's members. */
  documentFrequency: number;
  /** Surface forms, accented, most frequent first. */
  forms: readonly string[];
  stem: string;
};

/**
 * Canonicalised first: a combining mark is `\p{M}`, not `\p{L}`, so decomposed
 * text fails a letters-only test that precomposed text passes. Extracted
 * corpus text and typed queries both arrive in whichever form their producer
 * used, and rejecting one spelling of a word it accepts in the other is a
 * silent recall loss rather than a safety property.
 */
export const isSurfaceForm = (value: string): boolean =>
  SURFACE_FORM_PATTERN.test(value.normalize("NFC"));

/**
 * `<stem>\t<form,form,...>\t<documentFrequency>` per line. Tab-separated
 * because no field can contain a tab: stems and forms are letters, the
 * frequency is a decimal integer.
 */
export const serializeExpansionDictionary = (
  buckets: readonly ExpansionBucket[],
): string =>
  buckets
    .map(
      (bucket) =>
        `${bucket.stem}\t${bucket.forms.join(FORM_SEPARATOR)}\t${bucket.documentFrequency}`,
    )
    .join("\n");

export type ParsedExpansionDictionary = {
  /**
   * Folded keys two different buckets both claimed, and which therefore
   * expand to nothing. Reported so the count is observable rather than
   * inferred from missing recall.
   */
  collidedKeys: number;
  /**
   * Folded surface form to the bucket's forms packed as one delimited
   * string. One string per bucket is shared by every member's entry, so the
   * heap cost is the bucket's text once plus a pointer per member.
   */
  entries: ReadonlyMap<string, string>;
  /** Lines that did not parse, or carried a value the filter rejected. */
  skippedLines: number;
};

/**
 * Read a serialized dictionary. A malformed line is skipped and counted,
 * never thrown on: the payload is built offline from corpus text, and one bad
 * line must cost one bucket rather than every query the language serves.
 *
 * Keys are folded and values are not, so two buckets whose stems differ only
 * by diacritics claim the same key: Czech `rada`/`řada` and Polish `sad`/`sąd`
 * are ordinary words, not edge cases. Letting the later line win would answer
 * a query for one family with the other family's inflections, and the
 * prefix guard cannot see it because the folded spellings agree. Such a key
 * expands to nothing instead — an ambiguous lookup is resolved by declining
 * to answer, never by serialization order.
 */
export const parseExpansionDictionary = (
  text: string,
): ParsedExpansionDictionary => {
  const entries = new Map<string, string>();
  const collided = new Set<string>();
  let skippedLines = 0;

  for (const line of text.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const fields = line.split("\t");
    if (fields.length !== LINE_FIELDS) {
      skippedLines += 1;
      continue;
    }
    const [, packed] = fields;
    if (packed === undefined) {
      skippedLines += 1;
      continue;
    }
    const forms = packed.split(FORM_SEPARATOR);
    if (
      forms.length < MIN_FORMS_PER_BUCKET ||
      forms.length > MAX_FORMS_PER_BUCKET ||
      !forms.every(isSurfaceForm)
    ) {
      skippedLines += 1;
      continue;
    }
    for (const form of forms) {
      const key = foldExpansionKey(form);
      if (collided.has(key)) {
        continue;
      }
      const claimed = entries.get(key);
      if (claimed === undefined) {
        entries.set(key, packed);
        continue;
      }
      // Two forms of one bucket may fold together (`rada` and `ráda` within
      // the same family); that is the same answer twice, not a conflict.
      if (claimed === packed) {
        continue;
      }
      entries.delete(key);
      collided.add(key);
    }
  }

  return { collidedKeys: collided.size, entries, skippedLines };
};

/** Unpack a stored bucket value into its surface forms. */
export const unpackExpansionForms = (packed: string): string[] =>
  packed.split(FORM_SEPARATOR);
