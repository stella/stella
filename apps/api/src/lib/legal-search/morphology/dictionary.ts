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

import { foldToAscii } from "@stll/text-normalize";

import type { MorphologyLanguage } from "@/api/lib/legal-search/morphology/stem";

const KEY_PREFIX = "legal-corpus/morphology";

/** sha256 hex, the only shape a dictionary payload is addressed by. */
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Shortest and longest a surface form may be, in characters. The bound is the
 * same one the builder filters corpus tokens with, single-sourced here so the
 * two cannot drift: a loader that accepted what the builder would never emit
 * is a loader validating a different format than the one being produced.
 */
export const SURFACE_FORM_MIN_LENGTH = 3;
export const SURFACE_FORM_MAX_LENGTH = 30;

/**
 * A surface form is letters and nothing else, within the length bound. Digits,
 * punctuation, and whitespace are excluded at the source: a form that carried
 * them could not be a word the stemmer bucketed, and letters-only is what lets
 * the packed value use a comma as its separator without an escape rule.
 *
 * The length bound is load-bearing rather than cosmetic. The leaf budget caps
 * how many quoted values a query may carry, not how long one may be, so an
 * unbounded form would let a payload pair an ordinary key with a
 * multi-megabyte value and have an ordinary search build an enormous clause.
 * The dictionary is corpus-derived and read from object storage, so its
 * contents are checked here rather than assumed.
 */
const SURFACE_FORM_PATTERN = new RegExp(
  String.raw`^\p{L}{${SURFACE_FORM_MIN_LENGTH},${SURFACE_FORM_MAX_LENGTH}}$`,
  "u",
);

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
 * Which dictionary a query was built against: one payload, or none at all.
 *
 * A search cursor carries this, so a continuation page can only be ranked
 * against the payload its first page was built with. `none` is one answer
 * rather than several: a mode that expands nothing, a jurisdiction with no
 * dictionary, and a payload that could not be read all executed the same
 * unexpanded query, so they page against each other consistently.
 */
export type ExpansionDictionaryIdentity =
  | { contentHash: string; type: "dictionary" }
  | { type: "none" };

/**
 * Serialized `none`. A sha256 hex string is 64 characters, so this can never
 * collide with a payload's identity.
 */
const NO_EXPANSION_DICTIONARY = "none";

export const NO_EXPANSION_DICTIONARY_IDENTITY: ExpansionDictionaryIdentity = {
  type: "none",
};

export const serializeExpansionDictionaryIdentity = (
  identity: ExpansionDictionaryIdentity,
): string => {
  switch (identity.type) {
    case "dictionary": {
      return identity.contentHash;
    }
    case "none": {
      return NO_EXPANSION_DICTIONARY;
    }
    default: {
      return identity satisfies never;
    }
  }
};

/**
 * Read an identity back off the wire. The value arrives inside a cursor a
 * client hands back, so the hash shape is enforced rather than trusted:
 * anything that is neither the sentinel nor a sha256 hex string is not an
 * identity this service ever issued.
 *
 * Enforced with this module's own hash guard rather than a schema of its own.
 * The shape has one owner here — the same guard admits the pointer object that
 * chooses which payload key is read — and a second spelling of what a content
 * hash is would be a rule that can drift from the one the loader applies.
 */
export const parseExpansionDictionaryIdentity = (
  value: string,
): ExpansionDictionaryIdentity | null => {
  if (value === NO_EXPANSION_DICTIONARY) {
    return NO_EXPANSION_DICTIONARY_IDENTITY;
  }
  return isMorphologyDictionaryContentHash(value)
    ? { contentHash: value, type: "dictionary" }
    : null;
};

/**
 * Whether two identities name the same payload. Compared through the
 * serialized form, so what a cursor carries and what the comparison reads
 * cannot drift into two answers.
 */
export const sameExpansionDictionary = (
  left: ExpansionDictionaryIdentity,
  right: ExpansionDictionaryIdentity,
): boolean =>
  serializeExpansionDictionaryIdentity(left) ===
  serializeExpansionDictionaryIdentity(right);

/**
 * Lookup key for a surface form: lowercased, then folded to ASCII.
 *
 * Keys are folded, values are not. The corpus is written with diacritics and
 * queries frequently are not, so folding the key is what lets "skody" reach
 * the bucket "škody" sits in. The forms the query emits keep their accents,
 * because the engine folds its own query terms and an accented form matches
 * strictly more index terms than its folded spelling would.
 *
 * `foldToAscii` rather than a mark strip, because the engine's `ascii_folding`
 * and PostgreSQL `unaccent()` fold letters that have no canonical
 * decomposition: Polish `ł` survives NFD plus mark removal, so a key built
 * that way is spelled differently from every lexeme the index stored for it.
 * The fold decomposes internally, so the key is form-independent without a
 * separate NFC pass.
 *
 * Case folding runs first, the order the index applies: `FOLDED_TOKENIZER`
 * lists `lower_caser` before `ascii_folding`, and the builder's vocabulary
 * comes from `to_tsvector('simple', ...)`, which has already lowercased. The
 * two orders are not interchangeable for a character whose lowercase form the
 * fold table does not reach: `Ɩ` folds to `I` but lowercases to `ɩ`, so
 * folding first would key an uppercase query on `iota` while the corpus form
 * keys `ɩota`, and the bucket would be unreachable from that spelling.
 *
 * The stemmer deliberately runs the other way round (fold after stemming),
 * which is why it is never called here: this fold destroys exactly the
 * characters the suffix tables are written over.
 */
export const foldExpansionKey = (term: string): string =>
  foldToAscii(term.toLowerCase());

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
 * by what the fold removes claim the same key: Czech `rada`/`řada`, Polish
 * `sad`/`sąd` and `łaska`/`laska` are ordinary words, not edge cases. Letting
 * the later line win would answer a query for one family with the other
 * family's inflections, and the prefix guard cannot see it because the folded
 * spellings agree. Such a key expands to nothing instead: an ambiguous lookup
 * is resolved by declining to answer, never by serialization order.
 */
type ParseAccumulator = {
  collided: Set<string>;
  entries: Map<string, string>;
  skippedLines: number;
};

/**
 * Fold one line into the accumulator. The single definition of what a line
 * means: both drivers below run exactly this, so a synchronous parse and a
 * yielding one cannot drift into different readings of the format.
 */
const parseLine = (line: string, acc: ParseAccumulator): void => {
  if (line.length === 0) {
    return;
  }
  const fields = line.split("\t");
  if (fields.length !== LINE_FIELDS) {
    acc.skippedLines += 1;
    return;
  }
  const [, packed] = fields;
  if (packed === undefined) {
    acc.skippedLines += 1;
    return;
  }
  const forms = packed.split(FORM_SEPARATOR);
  if (
    forms.length < MIN_FORMS_PER_BUCKET ||
    forms.length > MAX_FORMS_PER_BUCKET ||
    !forms.every(isSurfaceForm)
  ) {
    acc.skippedLines += 1;
    return;
  }
  for (const form of forms) {
    const key = foldExpansionKey(form);
    if (acc.collided.has(key)) {
      continue;
    }
    const claimed = acc.entries.get(key);
    if (claimed === undefined) {
      acc.entries.set(key, packed);
      continue;
    }
    // Two forms of one bucket may fold together (`rada` and `ráda` within
    // the same family); that is the same answer twice, not a conflict.
    if (claimed === packed) {
      continue;
    }
    acc.entries.delete(key);
    acc.collided.add(key);
  }
};

const newParseAccumulator = (): ParseAccumulator => ({
  collided: new Set<string>(),
  entries: new Map<string, string>(),
  skippedLines: 0,
});

const finishParse = ({
  collided,
  entries,
  skippedLines,
}: ParseAccumulator): ParsedExpansionDictionary => ({
  collidedKeys: collided.size,
  entries,
  skippedLines,
});

export const parseExpansionDictionary = (
  text: string,
): ParsedExpansionDictionary => {
  const acc = newParseAccumulator();
  for (const line of text.split("\n")) {
    parseLine(line, acc);
  }
  return finishParse(acc);
};

/** Lines folded per turn. Small enough that a single batch is imperceptible. */
const PARSE_BATCH_LINES = 2000;

/**
 * The same parse, handing the event loop back between batches.
 *
 * Parsing is the CPU half of loading a dictionary and it is not cheap: every
 * line splits twice, and every form is lower-cased, decomposed and folded
 * before it keys a Map. On a payload near the ceiling that is long enough to
 * stall an API replica, and detaching the fetch does not help —
 * a detached promise's continuation still runs on the same thread. A warm-up or
 * a rebuild should not pause the requests happening around it.
 */
export const parseExpansionDictionaryOffLoop = async (
  text: string,
): Promise<ParsedExpansionDictionary> => {
  const acc = newParseAccumulator();
  const lines = text.split("\n");

  const parseFrom = async (start: number): Promise<void> => {
    const end = Math.min(start + PARSE_BATCH_LINES, lines.length);
    for (let index = start; index < end; index += 1) {
      parseLine(lines[index] ?? "", acc);
    }
    if (end >= lines.length) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await parseFrom(end);
  };

  await parseFrom(0);
  return finishParse(acc);
};

/** Unpack a stored bucket value into its surface forms. */
export const unpackExpansionForms = (packed: string): string[] =>
  packed.split(FORM_SEPARATOR);
