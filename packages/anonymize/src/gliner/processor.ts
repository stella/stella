/**
 * Tokenization and input preparation for GLiNER span model.
 *
 * Splits text into word tokens, encodes via HuggingFace
 * tokenizer, and builds the span index grid that the ONNX
 * model expects as input.
 */
import type { Encoding, Tokenizer } from "@huggingface/tokenizers";

const segmenter = new Intl.Segmenter(undefined, {
  granularity: "word",
});

/** Tokenize text into words with character offsets. */
export const tokenizeText = (
  text: string,
): [words: string[], starts: number[], ends: number[]] => {
  const words: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];

  for (const { segment, index, isWordLike } of segmenter.segment(text)) {
    // Include words and numeric segments (Intl.Segmenter
    // marks pure digit sequences as non-word-like, but the
    // NER model needs them for entity detection).
    if (!isWordLike && !/\d/u.test(segment)) {
      continue;
    }
    words.push(segment);
    starts.push(index);
    ends.push(index + segment.length);
  }

  return [words, starts, ends];
};

/** Build entity label <-> id mappings. */
const createMappings = (
  labels: string[],
): {
  classToId: Record<string, number>;
  idToClass: Record<number, string>;
} => {
  const classToId: Record<string, number> = {};
  const idToClass: Record<number, string> = {};
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label === undefined) {
      continue;
    }
    const id = i + 1;
    classToId[label] = id;
    idToClass[id] = label;
  }
  return { classToId, idToClass };
};

/** Prepend entity prompt tokens to word tokens. */
const prepareTextInputs = (
  batchTokens: string[][],
  entities: string[],
): [inputTexts: string[][], textLengths: number[], promptLengths: number[]] => {
  const inputTexts: string[][] = [];
  const promptLengths: number[] = [];
  const textLengths: number[] = [];

  for (const tokens of batchTokens) {
    textLengths.push(tokens.length);

    const prompt: string[] = [];
    for (const ent of entities) {
      prompt.push("<<ENT>>");
      prompt.push(ent);
    }
    prompt.push("<<SEP>>");

    promptLengths.push(prompt.length);
    inputTexts.push([...prompt, ...tokens]);
  }

  return [inputTexts, textLengths, promptLengths];
};

/** Encode word sequences into token IDs with masks. */
const encodeInputs = (
  tokenizer: Tokenizer,
  texts: string[][],
  promptLengths: number[],
): [
  inputIds: number[][],
  attentionMasks: number[][],
  wordsMasks: number[][],
] => {
  // Resolve special token IDs dynamically instead of
  // hardcoding DeBERTa-v3 values. Fallbacks (1, 2) match
  // the current model but future models may differ.
  const clsTokenId = tokenizer.token_to_id("[CLS]") ?? 1;
  const sepTokenId = tokenizer.token_to_id("[SEP]") ?? 2;

  const allInputIds: number[][] = [];
  const allAttentionMasks: number[][] = [];
  const allWordsMasks: number[][] = [];

  for (let idx = 0; idx < texts.length; idx++) {
    const promptLength = promptLengths[idx] ?? 0;
    const words = texts[idx];
    if (!words) {
      continue;
    }
    const wordsMask: number[] = [0];
    const inputIds: number[] = [clsTokenId];
    const attentionMask: number[] = [1];

    let wordCounter = 1;
    for (let wordId = 0; wordId < words.length; wordId++) {
      const word = words[wordId];
      if (word === undefined) {
        continue;
      }
      // encode() returns { ids, tokens, attention_mask }
      // with BOS/EOS; strip them with slice(1, -1)
      const encoded: Encoding = tokenizer.encode(word);
      const wordTokens: number[] = encoded.ids.slice(1, -1);

      for (let tokenId = 0; tokenId < wordTokens.length; tokenId++) {
        attentionMask.push(1);
        if (wordId < promptLength) {
          wordsMask.push(0);
        } else if (tokenId === 0) {
          wordsMask.push(wordCounter);
          wordCounter++;
        } else {
          wordsMask.push(0);
        }
        inputIds.push(wordTokens[tokenId] ?? 0);
      }
    }

    inputIds.push(sepTokenId);
    wordsMask.push(0);
    attentionMask.push(1);

    allInputIds.push(inputIds);
    allAttentionMasks.push(attentionMask);
    allWordsMasks.push(wordsMask);
  }

  return [allInputIds, allAttentionMasks, allWordsMasks];
};

/** Build span index pairs and masks for the model. */
const prepareSpans = (
  batchTokens: string[][],
  maxWidth: number,
): { spanIdxs: number[][][]; spanMasks: boolean[][] } => {
  const spanIdxs: number[][][] = [];
  const spanMasks: boolean[][] = [];

  for (const tokens of batchTokens) {
    const len = tokens.length;
    const idx: number[][] = [];
    const mask: boolean[] = [];

    for (let i = 0; i < len; i++) {
      for (let j = 0; j < maxWidth; j++) {
        const endIdx = Math.min(i + j, len - 1);
        idx.push([i, endIdx]);
        mask.push(endIdx < len);
      }
    }

    spanIdxs.push(idx);
    spanMasks.push(mask);
  }

  return { spanIdxs, spanMasks };
};

/** Pad a 2D or 3D array to uniform inner length. */
export const padArray = <T>(arr: T[][], dimensions: number = 2): T[][] => {
  if (arr.length === 0) {
    return [];
  }
  const maxLength = Math.max(...arr.map((sub) => sub.length));
  // For 3D arrays, infer inner dimension from the first
  // non-empty element (arr[0] may be empty when a batch
  // element had zero word tokens).
  let finalDim = 0;
  if (dimensions === 3) {
    for (const sub of arr) {
      if (sub.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- 3D arrays have number[] inner elements
        const inner = sub[0] as unknown as number[];
        finalDim = inner.length;
        break;
      }
    }
  }

  return arr.map((sub) => {
    const padCount = maxLength - sub.length;
    const fill =
      dimensions === 3
        ? Array.from({ length: padCount }, () =>
            Array.from<number>({ length: finalDim }).fill(0),
          )
        : Array.from<number>({ length: padCount }).fill(0);
    // SAFETY: fill values (zero arrays) match the shape of T
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic padding for ONNX tensor arrays
    return [...sub, ...(fill as T[])] as T[];
  });
};

/** Prepare a complete batch for ONNX inference. */
export const prepareBatch = (
  tokenizer: Tokenizer,
  texts: string[],
  entities: string[],
  maxWidth: number,
): {
  inputsIds: number[][];
  attentionMasks: number[][];
  wordsMasks: number[][];
  textLengths: number[];
  spanIdxs: number[][][];
  spanMasks: boolean[][];
  idToClass: Record<number, string>;
  batchTokens: string[][];
  batchWordsStartIdx: number[][];
  batchWordsEndIdx: number[][];
} => {
  const batchTokens: string[][] = [];
  const batchWordsStartIdx: number[][] = [];
  const batchWordsEndIdx: number[][] = [];

  for (const text of texts) {
    const [words, starts, ends] = tokenizeText(text);
    batchTokens.push(words);
    batchWordsStartIdx.push(starts);
    batchWordsEndIdx.push(ends);
  }

  const { idToClass } = createMappings(entities);

  const [inputTokens, textLengths, promptLengths] = prepareTextInputs(
    batchTokens,
    entities,
  );

  let [inputsIds, attentionMasks, wordsMasks] = encodeInputs(
    tokenizer,
    inputTokens,
    promptLengths,
  );

  inputsIds = padArray(inputsIds);
  attentionMasks = padArray(attentionMasks);
  wordsMasks = padArray(wordsMasks);

  let { spanIdxs, spanMasks } = prepareSpans(batchTokens, maxWidth);

  spanIdxs = padArray(spanIdxs, 3);
  spanMasks = padArray(spanMasks);

  return {
    inputsIds,
    attentionMasks,
    wordsMasks,
    textLengths,
    spanIdxs,
    spanMasks,
    idToClass,
    batchTokens,
    batchWordsStartIdx,
    batchWordsEndIdx,
  };
};
