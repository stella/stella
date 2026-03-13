// TODO: FIXME — @huggingface/transformers and onnxruntime-web types resolve as error/any
/**
 * GLiNER span-level NER model (web-only).
 *
 * Forked from gliner@0.0.19 (MIT license). Stripped to
 * span-level model only, web-only execution, typed, and
 * using onnxruntime-web directly. The tokenizer is loaded
 * via @huggingface/transformers AutoTokenizer.
 *
 * Original: github.com/Ingvarstep/GLiNER.js
 */
import type { PreTrainedTokenizer } from "@huggingface/transformers";
import { AutoTokenizer, env } from "@huggingface/transformers";
import type { Tensor } from "onnxruntime-web";

import { decodeSpans } from "./decoder";
import { createOnnxWrapper } from "./onnx-wrapper";
import { prepareBatch } from "./processor";
import type {
  EntityResult,
  GlinerConfig,
  OnnxWrapper,
  RawInferenceResult,
} from "./types";

export type { EntityResult, ExecutionProvider, GlinerConfig } from "./types";

const DEFAULT_MAX_WIDTH = 12;

export class Gliner {
  private readonly config: GlinerConfig;
  private readonly maxWidth: number;
  private onnx: OnnxWrapper | null = null;
  // oxlint-disable-next-line typescript-eslint/no-redundant-type-constituents
  private tokenizer: PreTrainedTokenizer | null = null;

  constructor(config: GlinerConfig) {
    this.config = config;
    // oxlint-disable-next-line typescript-eslint/no-unsafe-member-access
    env.allowLocalModels = false;
    // oxlint-disable-next-line typescript-eslint/no-unsafe-member-access
    env.useBrowserCache = false;
    this.maxWidth = config.maxWidth ?? DEFAULT_MAX_WIDTH;
  }

  async initialize(): Promise<void> {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access
    this.tokenizer = await AutoTokenizer.from_pretrained(
      this.config.tokenizerPath,
    );

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
    // oxlint-disable-next-line typescript-eslint/strict-boolean-expressions
    if (!this.onnx || !this.tokenizer) {
      throw new Error("Model not initialised. Call initialize() first.");
    }

    const batch = prepareBatch(this.tokenizer, texts, entities, this.maxWidth);

    const batchSize = batch.batchTokens.length;
    const numTokens = batch.inputsIds[0].length;
    const numSpans = batch.spanIdxs[0].length;

    const { ort } = this.onnx;

    const tensor = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- flat() produces mixed arrays
      data: any[],
      shape: number[],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- onnxruntime tensor type param
      dtype: any = "int64",
    ): Tensor =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- flat data for ONNX tensor
      // oxlint-disable-next-line typescript-eslint/no-unsafe-call
      new ort.Tensor(dtype, data.flat(Infinity), shape);

    const feeds = {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
      input_ids: tensor(batch.inputsIds, [batchSize, numTokens]),
      // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
      attention_mask: tensor(batch.attentionMasks, [batchSize, numTokens]),
      // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
      words_mask: tensor(batch.wordsMasks, [batchSize, numTokens]),
      // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
      text_lengths: tensor(
        batch.textLengths.map((l) => [l]),
        [batchSize, 1],
      ),
      // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
      span_idx: tensor(batch.spanIdxs, [batchSize, numSpans, 2]),
      // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
      span_mask: tensor(batch.spanMasks, [batchSize, numSpans], "bool"),
    };

    // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
    const results = await this.onnx.run(feeds);
    // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-member-access
    const logits = results["logits"];

    const inputLength = Math.max(...batch.textLengths);
    const numEntities = entities.length;
    const batchIds = Array.from({ length: batchSize }, (_, i) => i);

    const raw: RawInferenceResult = decodeSpans(
      batchSize,
      inputLength,
      this.maxWidth,
      numEntities,
      texts,
      batchIds,
      batch.batchWordsStartIdx,
      batch.batchWordsEndIdx,
      batch.idToClass,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- logits.data is Float32Array, accessed by index like number[]
      // oxlint-disable-next-line typescript-eslint/no-unsafe-member-access, typescript-eslint/no-unsafe-type-assertion
      logits.data as unknown as number[],
      flatNer,
      threshold,
      multiLabel,
    );

    return raw.map((batchResult) =>
      batchResult.map(([spanText, start, end, label, score]) => ({
        spanText,
        start,
        end,
        label,
        score,
      })),
    );
  }
}
