import { panic, Result } from "better-result";

import { getContextWindowTokens } from "@stll/ai-catalog";

import { BYTES_PER_TOKEN_ESTIMATE } from "@/api/lib/ai-generation/token-estimate";
import type { ReviewWithheldSource } from "@/api/lib/document-review/contract";
import { DocumentTooLargeError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import { sanitizeForPrompt, untrustedText } from "@/api/lib/prompt-safety";
import { getTanStackTextModelInfoForTask } from "@/api/lib/tanstack-ai-models";
import {
  buildDocxBlocksMessage,
  buildExtractedFileMessage,
  docxBlockOverheadBytes,
} from "@/api/lib/workflow/ai-prompts";
import type {
  PreparedDocxFile,
  PreparedInputFile,
} from "@/api/lib/workflow/generate-batch";

// Room for what the byte estimate cannot see, such as provider message framing
// and text that tokenizes worse than the densest script.
const CONTEXT_WINDOW_USABLE_SHARE = 0.9;
const RESERVED_OUTPUT_TOKENS = 16_000;
// Prompts, skills, text inputs and the output schema of one request.
const RESERVED_PROMPT_TOKENS = 16_000;
// A PDF reaches the provider whole, as text plus a page image, and cannot be
// cut. This is the low end of what providers publish per page.
const PDF_PAGE_TOKEN_ESTIMATE = 1500;
/** Past this share withheld, an answer would describe a document the model
 *  mostly did not read, so the request is refused instead. */
const MAX_WITHHELD_TEXT_SHARE = 0.5;

const withheldMarker = (characters: number): string =>
  `[… ${String(characters)} characters withheld …]`;

/** A marker of any real length fits this, so a cut can be sized before its
 *  count is known. */
const MARKER_RESERVE_BYTES = Buffer.byteLength(
  withheldMarker(Number.MAX_SAFE_INTEGER),
);
// Below this a trimmed passage would be little more than its marker.
const MIN_CAP_BYTES = MARKER_RESERVE_BYTES * 4;

const JSON_ESCAPE_BYTES = 2;
const JSON_CONTROL_ESCAPE_BYTES = 6;
const LAST_CONTROL_CODE_POINT = 0x1f;
const LAST_ONE_BYTE_CODE_POINT = 0x7f;
const LAST_TWO_BYTE_CODE_POINT = 0x7_ff;
const LAST_THREE_BYTE_CODE_POINT = 0xff_ff;
const SURROGATES = { first: 0xd8_00, last: 0xdf_ff } as const;

/** Bytes one code point takes in the prompt, where text is JSON-escaped. */
const codePointBytes = (codePoint: number): number => {
  if (codePoint === 0x22 || codePoint === 0x5c) {
    return JSON_ESCAPE_BYTES;
  }
  if (codePoint <= LAST_CONTROL_CODE_POINT) {
    return JSON_CONTROL_ESCAPE_BYTES;
  }
  if (codePoint <= LAST_ONE_BYTE_CODE_POINT) {
    return 1;
  }
  if (codePoint <= LAST_TWO_BYTE_CODE_POINT) {
    return 2;
  }
  if (codePoint >= SURROGATES.first && codePoint <= SURROGATES.last) {
    return JSON_CONTROL_ESCAPE_BYTES;
  }
  return codePoint <= LAST_THREE_BYTE_CODE_POINT ? 3 : 4;
};

const textBytes = (text: string): number => {
  let bytes = 0;
  for (const character of text) {
    bytes += codePointBytes(character.codePointAt(0) ?? 0);
  }
  return bytes;
};

/** The longest run of whole code points, from one end, within `budget` bytes. */
const takeWithin = (characters: readonly string[], budget: number): number => {
  let taken = 0;
  let bytes = 0;
  for (const character of characters) {
    bytes += codePointBytes(character.codePointAt(0) ?? 0);
    if (bytes > budget) {
      break;
    }
    taken += 1;
  }
  return taken;
};

type TextCut = (text: string) => string;

type CutTally = { passagesCut: number; charactersWithheld: number };

// Provisos and exceptions often sit at the end of a clause, so a trimmed text
// keeps both ends and gives up its middle.
const textCutAtCap =
  (cap: number, tally: CutTally): TextCut =>
  (text) => {
    if (textBytes(text) <= cap) {
      return text;
    }
    const characters = Array.from(text);
    const kept = cap - MARKER_RESERVE_BYTES;
    const head = takeWithin(characters, Math.ceil(kept / 2));
    const tail = takeWithin(
      characters.slice(head).toReversed(),
      Math.floor(kept / 2),
    );
    const withheld = characters.length - head - tail;
    tally.passagesCut += 1;
    tally.charactersWithheld += withheld;
    return [
      characters.slice(0, head).join(""),
      withheldMarker(withheld),
      characters.slice(characters.length - tail).join(""),
    ].join("");
  };

const sourceTexts = (file: PreparedInputFile): readonly string[] => {
  switch (file.kind) {
    case "docx":
      return file.blocks.map((block) => block.text);
    case "extracted-text":
      return [file.content];
    case "pdf":
      return [];
    default:
      file satisfies never;
      return panic(`Unhandled file: ${String(file)}`);
  }
};

const fixedBytes = (file: PreparedInputFile): number => {
  switch (file.kind) {
    case "docx":
      return (
        Buffer.byteLength(
          buildDocxBlocksMessage({
            simplifiedName: file.simplifiedName,
            blocks: [],
          }),
        ) +
        file.blocks.reduce(
          (total, block) => total + docxBlockOverheadBytes(block),
          0,
        )
      );
    case "extracted-text":
      return Buffer.byteLength(
        buildExtractedFileMessage({
          simplifiedName: file.simplifiedName,
          content: sanitizeForPrompt(untrustedText("")),
        }),
      );
    case "pdf":
      return (
        file.pageCount * PDF_PAGE_TOKEN_ESTIMATE * BYTES_PER_TOKEN_ESTIMATE
      );
    default:
      file satisfies never;
      return panic(`Unhandled file: ${String(file)}`);
  }
};

/** The one length that lets every text keep what it can: texts shorter than the
 *  cap stay whole, and the room they leave goes to the longer ones. */
const waterLevel = (lengths: readonly number[], room: number): number => {
  const ascending = lengths.toSorted((left, right) => left - right);
  let remaining = room;
  for (const [index, length] of ascending.entries()) {
    const share = Math.floor(remaining / (ascending.length - index));
    if (length > share) {
      return share;
    }
    remaining -= length;
  }
  return panic(
    "A text set over its room must have a longest text over a share",
  );
};

export type RequestFit<TFile> =
  | { type: "whole"; files: readonly TFile[] }
  | {
      type: "cut";
      files: readonly TFile[];
      withheld: readonly [ReviewWithheldSource, ...ReviewWithheldSource[]];
    };

type FitOptions<TFile> = {
  files: readonly TFile[];
  budgetBytes: number;
};

const fitWith = <TFile extends PreparedInputFile>(
  { files, budgetBytes }: FitOptions<TFile>,
  cutFile: (file: TFile, cut: TextCut) => TFile,
): Result<RequestFit<TFile>, DocumentTooLargeError> => {
  const room =
    budgetBytes - files.reduce((total, file) => total + fixedBytes(file), 0);
  const lengths = files.flatMap((file) => sourceTexts(file).map(textBytes));
  const totalBytes = lengths.reduce((total, length) => total + length, 0);

  if (room >= totalBytes) {
    return Result.ok({ type: "whole", files });
  }
  if (room <= 0) {
    return Result.err(tooLarge(budgetBytes));
  }
  const cap = waterLevel(lengths, room);
  const withheldBytes = lengths.reduce(
    (total, length) => total + Math.max(0, length - cap),
    0,
  );
  if (
    cap < MIN_CAP_BYTES ||
    withheldBytes > totalBytes * MAX_WITHHELD_TEXT_SHARE
  ) {
    return Result.err(tooLarge(budgetBytes));
  }

  const cutFiles: TFile[] = [];
  const withheld: ReviewWithheldSource[] = [];
  for (const file of files) {
    const tally: CutTally = { passagesCut: 0, charactersWithheld: 0 };
    cutFiles.push(cutFile(file, textCutAtCap(cap, tally)));
    if (tally.passagesCut === 0) {
      continue;
    }
    withheld.push({
      fileFieldId: file.fileFieldId,
      ...tally,
      charactersTotal: sourceTexts(file).reduce(
        (total, text) => total + Array.from(text).length,
        0,
      ),
    });
  }
  const [first, ...rest] = withheld;
  if (first === undefined) {
    return panic("A request over budget must cut at least one text");
  }
  return Result.ok({
    type: "cut",
    files: cutFiles,
    withheld: [first, ...rest],
  });
};

const tooLarge = (budgetBytes: number): DocumentTooLargeError =>
  new DocumentTooLargeError({
    message:
      "The documents are too large for this model to read enough of them.",
    budgetBytes,
  });

const cutDocxFile = (
  file: PreparedDocxFile,
  cut: TextCut,
): PreparedDocxFile => ({
  ...file,
  blocks: file.blocks.map((block) => ({ ...block, text: cut(block.text) })),
});

const cutInputFile = (
  file: PreparedInputFile,
  cut: TextCut,
): PreparedInputFile => {
  switch (file.kind) {
    case "docx":
      return cutDocxFile(file, cut);
    case "extracted-text":
      return { ...file, content: cut(file.content) };
    case "pdf":
      return file;
    default:
      file satisfies never;
      return panic(`Unhandled file: ${String(file)}`);
  }
};

/**
 * Fits one request's files into its budget. Files that fit come back untouched.
 * Otherwise every text is capped at one common length, each block keeps its id,
 * and the same input always gives the same bytes, which prompt caching needs.
 */
export const fitFilesToRequestBudget = (
  options: FitOptions<PreparedInputFile>,
): Result<RequestFit<PreparedInputFile>, DocumentTooLargeError> =>
  fitWith(options, cutInputFile);

/** The same fit, for callers that hold only DOCX files. */
export const fitDocxFilesToRequestBudget = (
  options: FitOptions<PreparedDocxFile>,
): Result<RequestFit<PreparedDocxFile>, DocumentTooLargeError> =>
  fitWith(options, cutDocxFile);

/** What one model's context window leaves for document text, in bytes. */
export const requestBudgetBytes = (modelId: string): number =>
  Math.floor(
    (getContextWindowTokens(modelId) * CONTEXT_WINDOW_USABLE_SHARE -
      RESERVED_OUTPUT_TOKENS -
      RESERVED_PROMPT_TOKENS) *
      BYTES_PER_TOKEN_ESTIMATE,
  );

type ModelInfoOptions = Parameters<typeof getTanStackTextModelInfoForTask>;

/**
 * The budget of the model a task will use. When that model cannot be resolved,
 * the unknown-model window applies: the request itself then fails on the same
 * resolution, or never needed this model.
 */
export const requestBudgetBytesForTask = (
  ...args: ModelInfoOptions
): number => {
  const info = Result.try(() => getTanStackTextModelInfoForTask(...args));
  return requestBudgetBytes(Result.isOk(info) ? info.value.modelId : "");
};

const WITHHELD_SHARE_BUCKETS = [0.1, 0.25, 0.5] as const;

const withheldShareBucket = (share: number): string => {
  const ceiling = WITHHELD_SHARE_BUCKETS.find((bucket) => share <= bucket);
  return ceiling === undefined ? "over" : `up_to_${String(ceiling * 100)}pct`;
};

export const PROMPT_INPUT_TRUNCATED_EVENT = "workflow.prompt_input_truncated";

const TRUNCATED_INPUT = {
  docx: "docx_blocks",
  "extracted-text": "extracted_text",
  pdf: "pdf",
} as const satisfies Record<PreparedInputFile["kind"], string>;

/** Sizes only: this record must never carry document text. */
export const logRequestFit = (fit: RequestFit<PreparedInputFile>): void => {
  if (fit.type === "whole") {
    return;
  }
  const kindByField = new Map<string, PreparedInputFile["kind"]>(
    fit.files.map((file) => [file.fileFieldId, file.kind]),
  );
  for (const source of fit.withheld) {
    const kind = kindByField.get(source.fileFieldId);
    if (kind === undefined) {
      return panic("A withheld source is missing from its own fit");
    }
    logger.info(PROMPT_INPUT_TRUNCATED_EVENT, {
      input: TRUNCATED_INPUT[kind],
      truncated_parts: String(source.passagesCut),
      dropped_chars: String(source.charactersWithheld),
      withheld_share: withheldShareBucket(
        source.charactersWithheld / source.charactersTotal,
      ),
    });
  }
};
