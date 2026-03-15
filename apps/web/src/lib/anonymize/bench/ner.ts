/**
 * Bench NER wrapper: runs GLiNER PII Edge via
 * onnxruntime-node (CPU) for offline benchmarking.
 *
 * Not used in the web app; only for bench scripts.
 */
/* eslint-disable no-console -- CLI bench script */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  chunkText as splitChunks,
  computeChunkOffsets,
  decodeTokenSpans,
  DETECTION_SOURCES,
  mergeChunkEntities,
  prepareBatch,
} from "@stella/anonymize";
import type { Entity, NerInferenceFn } from "@stella/anonymize";

const MODEL_URL =
  "https://huggingface.co/knowledgator/gliner-pii-edge-v1.0/resolve/main/onnx/model.onnx";
const TOKENIZER_ID = "knowledgator/gliner-pii-edge-v1.0";

const CACHE_DIR = join(import.meta.dirname, "..", "__corpus__", ".model-cache");

/** Model's recommended threshold for token-level output. */
const PII_EDGE_THRESHOLD = 0.3;

/**
 * PII Edge native labels. These are the labels the model
 * was trained on; we send them as entity prompts.
 */
const PII_EDGE_LABELS = [
  "name",
  "first name",
  "last name",
  "dob",
  "email address",
  "phone number",
  "location address",
  "location city",
  "location state",
  "location country",
  "location zip",
  "account number",
  "bank account",
  "credit card",
  "ssn",
  "passport number",
  "driver license",
  "username",
] as const;

/**
 * Map PII Edge labels to canonical pipeline labels.
 * Labels not in this map pass through unchanged.
 */
const LABEL_MAP: Record<string, string> = {
  name: "person",
  "first name": "person",
  "last name": "person",
  username: "person",
  dob: "date",
  // "age" is not a date; drop it by mapping to empty string
  // (filtered out by the normalizeLabel consumer)
  "location city": "address",
  "location address": "address",
  "location state": "address",
  "location country": "address",
  "location zip": "address",
  "account number": "bank account number",
  "bank account": "bank account number",
  "credit card": "credit card number",
  ssn: "tax identification number",
  "driver license": "identity card number",
  // "ip address" and "url" have no good canonical match;
  // pass through as-is so they're visible in eval output
  // rather than being silently mislabelled
};

const normalizeLabel = (label: string): string => LABEL_MAP[label] ?? label;

/** Known SHA-256 hashes for model integrity verification. */
const KNOWN_HASHES: Record<string, string> = {
  "pii-edge-fp32.onnx":
    "4ca588722e6d79447ad4c9c230eeba3d9d472c672a9598184a34e9f77fc35836",
};

const verifyChecksum = (path: string, expected: string) => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(readFileSync(path));
  const actual = hasher.digest("hex");
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${path}:\n` +
        `  expected: ${expected}\n` +
        `  got:      ${actual}`,
    );
  }
};

/**
 * Download a file if not already cached. Verifies SHA-256
 * checksum for files with known hashes.
 */
const ensureCached = async (url: string, filename: string): Promise<string> => {
  mkdirSync(CACHE_DIR, { recursive: true });
  const dest = join(CACHE_DIR, filename);

  if (existsSync(dest)) {
    const expected = KNOWN_HASHES[filename];
    if (expected) {
      verifyChecksum(dest, expected);
    }
    return dest;
  }

  console.log(`Downloading ${filename}...`);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  writeFileSync(dest, Buffer.from(buffer));

  const expected = KNOWN_HASHES[filename];
  if (expected) {
    verifyChecksum(dest, expected);
  }

  console.log(`Cached ${filename} (${buffer.byteLength} bytes)`);

  return dest;
};

/** Fetch and cache a JSON file from HuggingFace. */
const fetchJson = async (
  url: string,
  filename: string,
): Promise<Record<string, unknown>> => {
  const path = await ensureCached(url, filename);
  const raw = readFileSync(path, "utf8");
  // eslint-disable-next-line no-unsafe-type-assertion -- JSON.parse returns `any`; the fetch callers only access known keys
  return JSON.parse(raw) as Record<string, unknown>;
};

/** Singleton session and tokenizer. */
let cachedSession: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- onnxruntime-node types vary by version
  session: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tokenizer type from @huggingface/tokenizers
  tokenizer: any;
} | null = null;

const getSession = async () => {
  if (cachedSession) {
    return cachedSession;
  }

  const modelPath = await ensureCached(MODEL_URL, "pii-edge-fp32.onnx");

  // Dynamic imports for Node-only dependencies
  const ort = await import("onnxruntime-node");
  const { Tokenizer } = await import("@huggingface/tokenizers");

  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
  });

  const baseUrl = `https://huggingface.co/${TOKENIZER_ID}/resolve/main`;
  const tokenizerJson = await fetchJson(
    `${baseUrl}/tokenizer.json`,
    "tokenizer.json",
  );
  const tokenizerConfig = await fetchJson(
    `${baseUrl}/tokenizer_config.json`,
    "tokenizer_config.json",
  );

  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);

  cachedSession = { session, tokenizer };
  return cachedSession;
};

/**
 * Run token-level inference on a single chunk of text.
 */
const inferChunk = async (
  chunkText: string,
  labels: string[],
): Promise<Entity[]> => {
  // eslint-disable-next-line no-unsafe-assignment -- onnxruntime-node session/tokenizer are untyped
  const { session, tokenizer } = await getSession();
  const ort = await import("onnxruntime-node");

  const batch = prepareBatch(
    // eslint-disable-next-line no-unsafe-argument -- tokenizer from @huggingface/tokenizers is untyped
    tokenizer,
    [chunkText],
    labels,
    12, // maxWidth (unused by token model, but required by prepareBatch)
  );

  // Guard: empty text produces 0 words which crashes ONNX reshape
  if ((batch.textLengths[0] ?? 0) === 0) {
    return [];
  }

  // Token-level model: 4 inputs only (no span_idx / span_mask)
  const inputIds = new ort.Tensor(
    "int64",
    BigInt64Array.from(batch.inputsIds.flat().map(BigInt)),
    [1, batch.inputsIds[0]?.length ?? 0],
  );
  const attentionMask = new ort.Tensor(
    "int64",
    BigInt64Array.from(batch.attentionMasks.flat().map(BigInt)),
    [1, batch.attentionMasks[0]?.length ?? 0],
  );
  const wordsMask = new ort.Tensor(
    "int64",
    BigInt64Array.from(batch.wordsMasks.flat().map(BigInt)),
    [1, batch.wordsMasks[0]?.length ?? 0],
  );
  // PII Edge ONNX export expects text_lengths as [batch, 1],
  // not [batch]. Shape [1] causes "Invalid rank: Got 1 Expected 2".
  const textLengths = new ort.Tensor(
    "int64",
    BigInt64Array.from(batch.textLengths.map(BigInt)),
    [1, 1],
  );

  const feeds = {
    input_ids: inputIds,
    attention_mask: attentionMask,
    words_mask: wordsMask,
    text_lengths: textLengths,
  };

  // eslint-disable-next-line no-unsafe-assignment, no-unsafe-call, no-unsafe-member-access -- onnxruntime-node session is untyped
  const output = await session.run(feeds);
  // eslint-disable-next-line no-unsafe-assignment, no-unsafe-member-access -- onnxruntime output tensors are untyped
  const logits = output.logits ?? output.output;

  // eslint-disable-next-line strict-boolean-expressions -- logits is untyped from onnxruntime
  if (!logits) {
    return [];
  }

  const numWords = batch.textLengths[0] ?? 0;
  const numEntities = labels.length;
  // eslint-disable-next-line no-unsafe-type-assertion, no-unsafe-member-access -- onnxruntime tensor data is Float32Array
  const modelData = logits.data as Float32Array;

  const decoded = decodeTokenSpans(
    1,
    numWords,
    numEntities,
    [chunkText],
    [0],
    batch.batchWordsStartIdx,
    batch.batchWordsEndIdx,
    batch.idToClass,
    modelData,
    PII_EDGE_THRESHOLD,
  );

  const entities: Entity[] = [];
  const batchResult = decoded[0];
  if (batchResult) {
    for (const span of batchResult) {
      entities.push({
        start: span[1],
        end: span[2],
        label: normalizeLabel(span[3]),
        text: span[0],
        score: span[4],
        source: DETECTION_SOURCES.NER,
      });
    }
  }

  return entities;
};

/**
 * Create a NerInferenceFn that runs PII Edge on CPU.
 * Chunks text, runs inference per chunk, merges results.
 */
export const createNerInference = (): NerInferenceFn => {
  const inference: NerInferenceFn = async (
    fullText: string,
    _labels: string[],
    _threshold: number,
  ): Promise<Entity[]> => {
    // Always use PII Edge's native labels, not the
    // pipeline's labels, for best model performance
    const labels = [...PII_EDGE_LABELS];

    const chunks = splitChunks(fullText);
    const offsets = computeChunkOffsets(fullText, chunks);

    const chunkResults: Entity[][] = [];
    for (const chunk of chunks) {
      const entities = await inferChunk(chunk, labels);
      chunkResults.push(entities);
    }

    return mergeChunkEntities(offsets, chunkResults);
  };

  return inference;
};
