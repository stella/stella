/**
 * Build the morphological expansion dictionary for one language.
 *
 * Query-time expansion is a Map lookup, never a stem: query text arrives
 * folded and decomposed in whatever combination a keyboard produced, and the
 * suffix tables are written over accented, precomposed characters. So the
 * stemming happens here, once, over the accented corpus vocabulary, and the
 * request path only reads what this produced.
 *
 * The vocabulary comes from `ts_stat` over `to_tsvector('simple', ...)` of the
 * decisions' searchable text — deliberately not the stored `tsv` column,
 * which is unaccent-folded and would hand the stemmer exactly the input it
 * mis-stems. Documents are read in keyset chunks with their own statement
 * timeout, sequentially, so this stays safe to run against a live instance.
 *
 * Buckets are formed by stem, singletons dropped (a bucket of one expands to
 * nothing), and each bucket capped at its most frequent surface forms. The
 * payload is content-addressed; a small pointer object names the current hash
 * so a rebuild is one small write and a rollback is the previous hash.
 *
 *   bun run src/scripts/build-expansion-dictionary.ts --language cs
 *   bun run src/scripts/build-expansion-dictionary.ts --language pl \
 *     --out expansion-pl.tsv
 */
import { sql } from "drizzle-orm";

import { rlsDb } from "@/api/db/root";
import { createIngestionDb } from "@/api/db/scoped";
import { zstdCompress } from "@/api/lib/compression";
import {
  type ExpansionBucket,
  foldExpansionKey,
  isSurfaceForm,
  MAX_FORMS_PER_BUCKET,
  MORPHOLOGY_DICTIONARY_MAX_BYTES,
  morphologyDictionaryKey,
  morphologyDictionaryPointerKey,
  parseExpansionDictionary,
  serializeExpansionDictionary,
} from "@/api/lib/legal-search/morphology/dictionary";
import {
  MORPHOLOGY_LANGUAGES,
  type MorphologyLanguage,
  stemLegalTerm,
} from "@/api/lib/legal-search/morphology/stem";
import { putCorpusS3ObjectWithSignal, refreshCorpusS3 } from "@/api/lib/s3";

const DEFAULT_CHUNK_SIZE = 1000;
/** Per-chunk ceiling. A measured chunk costs ~2s; this is the stall bound. */
const CHUNK_STATEMENT_TIMEOUT = "60s";
/** Corpus document frequency a token needs before it is worth bucketing. */
const DEFAULT_MIN_DOCUMENT_FREQUENCY = 50;
/**
 * Ceiling on distinct tokens retained during the scan. The frequency threshold
 * is a corpus-wide sum and cannot prune before the scan ends, so this is what
 * turns "grows with the corpus vocabulary" into a bounded, reportable failure.
 * Comfortably above a real Czech or Polish case-law vocabulary; a run that
 * trips it is describing a corpus this script's in-memory design does not fit.
 */
const DEFAULT_MAX_VOCABULARY = 8_000_000;
/**
 * Shared leading characters expected of a coherent bucket. Below this the
 * bucket's members are probably not the same word, so it is reported for
 * review; the query-time guard drops the offending forms either way.
 */
const COHERENCE_PREFIX = 3;
const UPLOAD_TIMEOUT_MS = 60_000;

const USAGE = `Usage: bun run src/scripts/build-expansion-dictionary.ts --language <cs|pl|sk> [options]

  --language <code>    Language to build. Required.
  --out <path>         Write the uncompressed dictionary here instead of uploading.
  --chunk <n>          Documents scanned per query (default ${DEFAULT_CHUNK_SIZE}).
  --min-df <n>         Minimum corpus document frequency (default ${DEFAULT_MIN_DOCUMENT_FREQUENCY}).
  --max-vocabulary <n> Distinct tokens retained before the run aborts (default ${DEFAULT_MAX_VOCABULARY}).`;

// Annotated on the binding, not just the return position: TypeScript only
// treats a call as never-returning (and narrows after it) when the callee is a
// name carrying an explicit type annotation.
const fail: (message: string) => never = (message) => {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
};

const flagValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`--${name} requires a value`);
  }
  return value;
};

const DECIMAL_INTEGER = /^\d+$/u;

const positiveInteger = (
  raw: string | undefined,
  fallback: number,
  name: string,
): number => {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = DECIMAL_INTEGER.test(raw)
    ? Number.parseInt(raw, 10)
    : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`--${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
};

const isMorphologyLanguage = (value: string): value is MorphologyLanguage =>
  MORPHOLOGY_LANGUAGES.some((language) => language === value);

const languageArg = flagValue("language");
if (languageArg === undefined) {
  fail("--language is required");
}
if (!isMorphologyLanguage(languageArg)) {
  fail(
    `--language must be one of ${MORPHOLOGY_LANGUAGES.join(", ")}, got: ${languageArg}`,
  );
}
const language: MorphologyLanguage = languageArg;
const outPath = flagValue("out");
const chunkSize = positiveInteger(
  flagValue("chunk"),
  DEFAULT_CHUNK_SIZE,
  "chunk",
);
const minDocumentFrequency = positiveInteger(
  flagValue("min-df"),
  DEFAULT_MIN_DOCUMENT_FREQUENCY,
  "min-df",
);
const maxVocabulary = positiveInteger(
  flagValue("max-vocabulary"),
  DEFAULT_MAX_VOCABULARY,
  "max-vocabulary",
);

const ingestionDb = createIngestionDb(rlsDb);

/** The keyset floor: uuids order lexically, so the nil uuid precedes them all. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const rowsOf = (result: unknown): Record<string, unknown>[] =>
  Array.isArray(result) ? result : [];

type VocabularyChunk = {
  /** Exclusive upper bound reached, or null when the language is exhausted. */
  lastId: string | null;
  scanned: number;
  tokens: Map<string, number>;
};

/**
 * Document frequency per token over one keyset chunk of decisions.
 *
 * Two statements, one transaction. The first names the chunk's closed id
 * range, because `ts_stat` returns word statistics and cannot also report
 * where the chunk ended. The second runs `ts_stat` over exactly that range.
 *
 * `ts_stat` takes its input as SQL text, so the range is spliced by Postgres'
 * own `format(%L)` from bound parameters rather than by string building here:
 * the quoting is the server's, and no value from this process reaches the
 * inner query unquoted.
 *
 * `simple` is the configuration on purpose. It neither stems nor unaccents,
 * so tokens come back spelled as the corpus wrote them, which is the input
 * the stemmer's suffix tables are written for. The stored `tsv` column is
 * unaccent-folded and would be the wrong source for exactly that reason.
 */
const chunkVocabulary = async (afterId: string): Promise<VocabularyChunk> =>
  await ingestionDb(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${CHUNK_STATEMENT_TIMEOUT}, true)`,
    );

    const bounds = rowsOf(
      await tx.execute(sql`
        SELECT max(decision_id)::text AS last_id, count(*)::int AS scanned
        FROM (
          SELECT sd.decision_id
          FROM case_law_search_documents sd
          WHERE sd.language = ${language}
            AND sd.decision_id > ${afterId}::uuid
          ORDER BY sd.decision_id
          LIMIT ${chunkSize}
        ) chunk
      `),
    );
    const lastId = bounds.at(0)?.["last_id"];
    const scanned = Number(bounds.at(0)?.["scanned"] ?? 0);
    if (typeof lastId !== "string" || scanned === 0) {
      return { lastId: null, scanned: 0, tokens: new Map() };
    }

    // `normalize(..., NFC)` before tokenization: extracted PDF text is often
    // decomposed, and `to_tsvector` would then emit tokens carrying combining
    // marks. Those are `\p{M}`, not `\p{L}`, so the token filter would drop
    // them and the corpus would silently lose the inflections of every
    // accented word that happened to arrive in NFD.
    const stats = rowsOf(
      await tx.execute(sql`
        SELECT word, ndoc
        FROM ts_stat(
          format(
            'SELECT to_tsvector(''simple'', normalize(sd.searchable_text, NFC))
               FROM case_law_search_documents sd
              WHERE sd.language = %L
                AND sd.decision_id > %L::uuid
                AND sd.decision_id <= %L::uuid',
            ${language}, ${afterId}, ${lastId}
          )
        )
      `),
    );

    // Shape-filtered here rather than after the whole scan: the frequency map
    // lives for the length of the build, and an OCR-heavy corpus produces
    // enough one-off garbage tokens to grow it without bound. Only the
    // frequency threshold needs the global total, so only it waits.
    const tokens = new Map<string, number>();
    for (const row of stats) {
      const word = row["word"];
      const ndoc = Number(row["ndoc"]);
      if (typeof word !== "string" || !Number.isFinite(ndoc)) {
        continue;
      }
      const canonical = word.normalize("NFC");
      if (isSurfaceForm(canonical)) {
        tokens.set(canonical, ndoc);
      }
    }
    return { lastId, scanned, tokens };
  });

console.log(
  `=== BUILD EXPANSION DICTIONARY: ${language} (chunk ${chunkSize}, min df ${minDocumentFrequency}) ===`,
);

const documentFrequency = new Map<string, number>();
let scannedDocuments = 0;

/**
 * Walk the language's documents one chunk at a time. Sequential by design:
 * this may run against a small live instance, and concurrent `ts_stat` passes
 * would multiply its cost for no wall-clock gain worth having.
 */
const scanFrom = async (afterId: string): Promise<void> => {
  const chunk = await chunkVocabulary(afterId);
  if (chunk.lastId === null) {
    return;
  }
  for (const [word, ndoc] of chunk.tokens) {
    documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + ndoc);
  }
  // The frequency threshold is a corpus-wide sum, so it cannot be applied
  // before the scan ends: a token reaching 50 documents may do so one document
  // per chunk, and any early prune would silently drop real vocabulary. The
  // retained map is therefore the language's whole distinct vocabulary,
  // including whatever letters-only noise OCR produced, and the shape filter
  // bounds its shape rather than its size. This is the size bound — chosen so
  // an oversized corpus stops here, before publishing, with something an
  // operator can act on, instead of being OOM-killed at an arbitrary point.
  if (documentFrequency.size > maxVocabulary) {
    console.error(
      `build-expansion-dictionary: vocabulary exceeded ${maxVocabulary} distinct tokens after ${scannedDocuments} documents; refusing to continue. Raise --max-vocabulary on a host with the memory for it, or aggregate the counts in the database instead.`,
    );
    process.exit(1);
  }
  scannedDocuments += chunk.scanned;
  console.log(
    `  scanned ${scannedDocuments} documents, ${documentFrequency.size} distinct tokens`,
  );
  await scanFrom(chunk.lastId);
};

await scanFrom(NIL_UUID);

// Bucket by stem. The token is stemmed accented, exactly as the corpus wrote
// it; folding here would strip the characters the suffix tables match on.
// Token shape was already enforced during the scan, so only the corpus-wide
// frequency threshold is left to apply.
const byStem = new Map<string, { df: number; form: string }[]>();
let filteredTokens = 0;
for (const [token, df] of documentFrequency) {
  if (df < minDocumentFrequency) {
    continue;
  }
  filteredTokens += 1;
  const stem = stemLegalTerm(token, language);
  const bucket = byStem.get(stem);
  if (bucket === undefined) {
    byStem.set(stem, [{ df, form: token }]);
    continue;
  }
  bucket.push({ df, form: token });
}

/** Code-unit order over two forms; a machine key, so no collation. */
const compareForms = (
  left: { form: string },
  right: { form: string },
): number => {
  if (left.form < right.form) {
    return -1;
  }
  return left.form > right.form ? 1 : 0;
};

const buckets: ExpansionBucket[] = [];
const incoherent: string[] = [];
for (const [stem, members] of byStem) {
  if (members.length < 2) {
    continue;
  }
  // Frequency first, then the form's own order. Without the tie-breaker, forms
  // with equal frequency straddling the cap are kept in the order `ts_stat`
  // happened to return them, so rebuilding the same corpus could select a
  // different four, expand differently, and publish under a different content
  // hash — which the content-addressed layout is supposed to rule out.
  members.sort(
    (left, right) => right.df - left.df || compareForms(left, right),
  );
  const forms = members
    .slice(0, MAX_FORMS_PER_BUCKET)
    .map((member) => member.form)
    .filter(isSurfaceForm);
  if (forms.length < 2) {
    continue;
  }
  buckets.push({
    documentFrequency: members.reduce((sum, member) => sum + member.df, 0),
    forms,
    stem,
  });

  const folded = forms.map(foldExpansionKey);
  const [first] = folded;
  if (
    first !== undefined &&
    !folded.every(
      (form) =>
        form.slice(0, COHERENCE_PREFIX) === first.slice(0, COHERENCE_PREFIX),
    )
  ) {
    incoherent.push(`${stem}\t${forms.join(",")}`);
  }
}

// Code-unit order, not collation: the sort exists to make two builds of the
// same corpus produce the same bytes, and a stem is a machine key.
buckets.sort((left, right) => (left.stem < right.stem ? -1 : 1));

const payload = serializeExpansionDictionary(buckets);

// The loader is the authority on what a folded key may resolve to, so the
// report comes from its own parser rather than from a second implementation
// here: whatever it drops for colliding keys is what the deployment will drop.
const { collidedKeys, entries, skippedLines } =
  parseExpansionDictionary(payload);

console.log(
  `tokens=${documentFrequency.size} kept=${filteredTokens} buckets=${buckets.length} keys=${entries.size} incoherent=${incoherent.length} collided=${collidedKeys} skipped=${skippedLines}`,
);
if (skippedLines > 0) {
  console.error(
    `build-expansion-dictionary: ${skippedLines} serialized lines do not parse; refusing to publish`,
  );
  process.exit(1);
}
if (collidedKeys > 0) {
  console.log(
    `--- ${collidedKeys} folded keys are claimed by more than one stem and expand to nothing (e.g. rada/řada, sad/sąd) ---`,
  );
}
if (incoherent.length > 0) {
  console.log(
    `--- buckets whose members share fewer than ${COHERENCE_PREFIX} leading characters (query-time prefix guard drops these forms) ---`,
  );
  for (const line of incoherent) {
    console.log(`  ${line}`);
  }
}

if (buckets.length === 0) {
  console.error(
    "build-expansion-dictionary: no buckets produced; refusing to publish an empty dictionary",
  );
  process.exit(1);
}

// Publishing past the loader's ceiling would advance the pointer to a payload
// every replica then rejects, so the deployment would silently serve
// unexpanded searches until an operator rolled it back. Fail here instead.
const payloadBytes = Buffer.byteLength(payload, "utf-8");
if (payloadBytes > MORPHOLOGY_DICTIONARY_MAX_BYTES) {
  console.error(
    `build-expansion-dictionary: ${payloadBytes} bytes exceeds the loader's ${MORPHOLOGY_DICTIONARY_MAX_BYTES}-byte ceiling; refusing to publish`,
  );
  process.exit(1);
}

if (outPath !== undefined) {
  await Bun.write(outPath, payload);
  console.log(`Wrote ${payload.length} bytes to ${outPath}.`);
  process.exit(0);
}

// Addressed by the dictionary's own bytes, not by the compressed frame, so
// the same corpus republishes to the same key whatever the encoder does.
const hasher = new Bun.CryptoHasher("sha256");
hasher.update(payload);
const contentHash = hasher.digest("hex");
const compressed = zstdCompress(payload);

await refreshCorpusS3();
await putCorpusS3ObjectWithSignal(
  morphologyDictionaryKey(language, contentHash),
  compressed,
  "application/zstd",
  AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
);
await putCorpusS3ObjectWithSignal(
  morphologyDictionaryPointerKey(language),
  new TextEncoder().encode(contentHash),
  "text/plain",
  AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
);

console.log(
  `Published ${buckets.length} buckets (${compressed.length} compressed bytes) at ${contentHash}.`,
);
process.exit(0);
