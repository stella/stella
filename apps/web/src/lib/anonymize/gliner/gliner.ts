/**
 * GLiNER span-level NER model (web-only).
 *
 * Forked from gliner@0.0.19 (MIT license). Stripped to
 * span-level model only, web-only execution, typed, and
 * using onnxruntime-web directly. The tokenizer is loaded
 * via @huggingface/tokenizers (pure JS, no ONNX dep).
 *
 * Original: github.com/Ingvarstep/GLiNER.js
 */
import { Tokenizer } from "@huggingface/tokenizers";
import type { Tensor } from "onnxruntime-web";

import { decodeSpans, prepareBatch, tokenizeText } from "@stella/anonymize";
import type { EntityResult, RawInferenceResult } from "@stella/anonymize";

import { createOnnxWrapper } from "./onnx-wrapper";
import type { GlinerConfig, OnnxWrapper } from "./onnx-wrapper";

export type { EntityResult } from "@stella/anonymize";
export type { ExecutionProvider, GlinerConfig } from "./onnx-wrapper";

const DEFAULT_MAX_WIDTH = 12;

const TOKENIZER_CACHE_NAME = "gliner-tokenizers";

/**
 * Fetch and cache tokenizer JSON files from HuggingFace.
 * Uses the Cache API so subsequent loads are instant.
 */
const fetchWithCache = async (
  url: string,
): Promise<Record<string, unknown>> => {
  // Cache API may be unavailable on non-secure origins
  // or in some browser/worker contexts. Scope the try/catch
  // to cache operations only so fetch errors surface
  // immediately without a redundant retry.
  let cache: Cache | null = null;
  try {
    cache = await caches.open(TOKENIZER_CACHE_NAME);
    const cached = await cache.match(url);
    if (cached) {
      // SAFETY: tokenizer JSON files are always objects
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return (await cached.json()) as Record<string, unknown>;
    }
  } catch {
    // Cache API unavailable — fall through to plain fetch
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  if (cache) {
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- quota errors are non-fatal
    await cache.put(url, response.clone()).catch(() => {});
  }
  // SAFETY: tokenizer JSON files are always objects
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return (await response.json()) as Record<string, unknown>;
};

const fetchTokenizerFiles = async (
  modelId: string,
): Promise<{
  tokenizerJson: Record<string, unknown>;
  tokenizerConfig: Record<string, unknown>;
}> => {
  const baseUrl = `https://huggingface.co/${modelId}/resolve/main`;
  const urls = [
    `${baseUrl}/tokenizer.json`,
    `${baseUrl}/tokenizer_config.json`,
  ];

  const results = await Promise.all(urls.map(fetchWithCache));
  const tokenizerJson = results[0] ?? {};
  const tokenizerConfig = results[1] ?? {};

  return { tokenizerJson, tokenizerConfig };
};

export class Gliner {
  private readonly config: GlinerConfig;
  private readonly maxWidth: number;
  private onnx: OnnxWrapper | null = null;
  private tokenizer: Tokenizer | null = null;

  constructor(config: GlinerConfig) {
    this.config = config;
    this.maxWidth = config.maxWidth ?? DEFAULT_MAX_WIDTH;
  }

  async initialize(): Promise<void> {
    const { tokenizerJson, tokenizerConfig } = await fetchTokenizerFiles(
      this.config.tokenizerPath,
    );

    this.tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);

    this.onnx = createOnnxWrapper(this.config.onnxSettings);
    await this.onnx.init();
  }

  async inference({
    texts,
    entities,
    flatNer = false,
    threshold = 0.5,
    multiLabel = false,
  }: {
    texts: string[];
    entities: string[];
    flatNer?: boolean;
    threshold?: number;
    multiLabel?: boolean;
  }): Promise<EntityResult[][]> {
    if (!this.onnx || !this.tokenizer) {
      throw new Error("Model not initialised. Call initialize() first.");
    }

    // Filter out texts with no word tokens. A text may be
    // non-empty after trim() but still produce zero words
    // from Intl.Segmenter (e.g., "... --- !!!", "§", "/:")
    // because punctuation is not word-like. These produce
    // empty span tensors that ONNX rejects with
    // "invalid input 'span_idx'".
    const validIndices: number[] = [];
    const validTexts: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      if (text === undefined) {
        continue;
      }
      const [words] = tokenizeText(text);
      if (words.length > 0) {
        validIndices.push(i);
        validTexts.push(text);
      }
    }

    // Return empty results for all texts if none are valid
    if (validTexts.length === 0) {
      return texts.map(() => []);
    }

    const batch = prepareBatch(
      this.tokenizer,
      validTexts,
      entities,
      this.maxWidth,
    );

    const batchSize = batch.batchTokens.length;

    // If all texts tokenize to zero words, return empty.
    // Check all elements (not just [0]) — mixed batches
    // where some elements have zero spans are also invalid.
    const maxSpans =
      batch.spanIdxs.length > 0
        ? Math.max(...batch.spanIdxs.map((s) => s.length))
        : 0;
    if (batchSize === 0 || maxSpans === 0) {
      return texts.map(() => []);
    }

    const numTokens = batch.inputsIds[0]?.length ?? 0;
    const numSpans = batch.spanIdxs[0]?.length ?? 0;

    const { ort } = this.onnx;

    const tensor = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- flat() produces mixed arrays
      data: any[],
      shape: number[],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- onnxruntime tensor type param
      dtype: any = "int64",
    ): Tensor =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- flat data for ONNX tensor
      new ort.Tensor(dtype, data.flat(Infinity), shape);

    const feeds = {
      input_ids: tensor(batch.inputsIds, [batchSize, numTokens]),
      attention_mask: tensor(batch.attentionMasks, [batchSize, numTokens]),
      words_mask: tensor(batch.wordsMasks, [batchSize, numTokens]),
      text_lengths: tensor(
        batch.textLengths.map((l) => [l]),
        [batchSize, 1],
      ),
      span_idx: tensor(batch.spanIdxs, [batchSize, numSpans, 2]),
      span_mask: tensor(batch.spanMasks, [batchSize, numSpans], "bool"),
    };

    const results = await this.onnx.run(feeds);
    const logits = results["logits"];
    if (!logits) {
      throw new Error("Model output missing 'logits' tensor");
    }

    const inputLength = Math.max(...batch.textLengths);
    const numEntities = entities.length;
    const batchIds = Array.from({ length: batchSize }, (_, i) => i);

    const raw: RawInferenceResult = decodeSpans(
      batchSize,
      inputLength,
      this.maxWidth,
      numEntities,
      validTexts,
      batchIds,
      batch.batchWordsStartIdx,
      batch.batchWordsEndIdx,
      batch.idToClass,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- logits.data is Float32Array, accessed by index like number[]
      logits.data as unknown as number[],
      flatNer,
      threshold,
      multiLabel,
    );

    const validResults = raw.map((batchResult) =>
      batchResult.map(([spanText, start, end, label, score]) => ({
        spanText,
        start,
        end,
        label,
        score,
      })),
    );

    // Map results back to original text indices
    const allResults: EntityResult[][] = texts.map(() => []);
    for (let i = 0; i < validIndices.length; i++) {
      const idx = validIndices[i];
      const result = validResults[i];
      if (idx === undefined || result === undefined) {
        continue;
      }
      allResults[idx] = result;
    }
    return allResults;
  }
}
