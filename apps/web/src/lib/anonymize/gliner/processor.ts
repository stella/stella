// TODO: FIXME — @huggingface/transformers PreTrainedTokenizer resolves as error type
/**
 * Tokenization and input preparation for GLiNER span model.
 *
 * Splits text into word tokens, encodes via HuggingFace
 * tokenizer, and builds the span index grid that the ONNX
 * model expects as input.
 */
import type { PreTrainedTokenizer } from "@huggingface/transformers";

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
    if (!isWordLike) {
      continue;
    }
    words.push(segment);
    starts.push(index);
    ends.push(index + segment.length);
  }

  return [words, starts, ends];
};

/** Build entity label ↔ id mappings. */
const createMappings = (
  labels: string[],
): {
  classToId: Record<string, number>;
  idToClass: Record<number, string>;
} => {
  const classToId: Record<string, number> = {};
  const idToClass: Record<number, string> = {};
  for (let i = 0; i < labels.length; i++) {
    const id = i + 1;
    classToId[labels[i]] = id;
    idToClass[id] = labels[i];
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
  tokenizer: PreTrainedTokenizer,
  texts: string[][],
  promptLengths: number[],
): [
  inputIds: number[][],
  attentionMasks: number[][],
  wordsMasks: number[][],
] => {
  const allInputIds: number[][] = [];
  const allAttentionMasks: number[][] = [];
  const allWordsMasks: number[][] = [];

  for (let idx = 0; idx < texts.length; idx++) {
    const promptLength = promptLengths[idx];
    const words = texts[idx];
    const wordsMask: number[] = [0];
    const inputIds: number[] = [1];
    const attentionMask: number[] = [1];

    let wordCounter = 1;
    for (let wordId = 0; wordId < words.length; wordId++) {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access -- PreTrainedTokenizer resolves as error type
      const wordTokens: number[] = tokenizer.encode(words[wordId]).slice(1, -1);

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
        inputIds.push(wordTokens[tokenId]);
      }
    }

    // oxlint-disable-next-line typescript-eslint/no-unsafe-argument, typescript-eslint/no-unsafe-member-access -- PreTrainedTokenizer resolves as error type
    inputIds.push(tokenizer.sep_token_id);
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
  const maxLength = Math.max(...arr.map((sub) => sub.length));
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- 3D arrays have number[] inner elements
  const firstInner = arr[0]?.[0] as unknown as number[] | undefined;
  const finalDim = dimensions === 3 && firstInner ? firstInner.length : 0;

  return arr.map((sub) => {
    const padCount = maxLength - sub.length;
    const fill =
      dimensions === 3
        ? Array.from({ length: padCount }, () =>
            Array.from<number>({ length: finalDim }).fill(0),
          )
        : Array.from<number>({ length: padCount }).fill(0);
    // SAFETY: fill values (zero arrays) match the shape of T
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generic padding for ONNX tensor arrays
    return [...sub, ...(fill as T[])] as T[];
  });
};

/** Prepare a complete batch for ONNX inference. */
export const prepareBatch = (
  tokenizer: PreTrainedTokenizer,
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
