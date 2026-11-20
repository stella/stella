import { Result, TaggedError } from "better-result";

import {
  initSync,
  RecordingBytes,
  RecordingPieces,
} from "../generated/recording.js";

/** Why a recording is not transcribed. */
export const RECORDING_REFUSALS = [
  "unsupported",
  "unreadable",
  "too_long",
  "dictaphone",
] as const;
export type RecordingRefusal = (typeof RECORDING_REFUSALS)[number];

export class RecordingRefusedError extends TaggedError(
  "RecordingRefusedError",
)<{ refusal: RecordingRefusal; message: string }> {}

const isRefusal = (value: string): value is RecordingRefusal =>
  (RECORDING_REFUSALS as readonly string[]).includes(value);

const refusalOf = (error: unknown): RecordingRefusedError => {
  const code = error instanceof Error ? error.message : "";
  const refusal = isRefusal(code) ? code : "unreadable";
  return new RecordingRefusedError({
    refusal,
    message: `The recording was refused: ${refusal}`,
  });
};

/** One piece of a recording, ready for one transcription request. */
export type RecordingPiece = {
  /** Zero-based, in the order spoken. */
  index: number;
  startMs: number;
  endMs: number;
  /** The quiet between the previous piece's last word and this one's. */
  pauseBeforeMs: number;
  /** Whether the piece holds anything loud enough to be speech. */
  speech: boolean;
  /** 16 kHz mono 16-bit PCM WAV. */
  wav: Uint8Array;
};

/** A recording opened for reading; pieces are decoded as they are asked
 *  for. `close` frees the recording's memory. */
export type OpenedRecording = {
  format: string;
  durationMs: number | null;
  next: () => Result<RecordingPiece | null, RecordingRefusedError>;
  close: () => void;
};

let initialized = false;

/** Compiles the reader once per thread. `module` is the compiled
 *  `generated/recording_bg.wasm`. */
export const initRecordingReader = (module: WebAssembly.Module): void => {
  if (initialized) {
    return;
  }
  initSync({ module });
  initialized = true;
};

/** Where the compiled reader lives, next to this file's generated glue. */
export const RECORDING_WASM_URL = new URL(
  "../generated/recording_bg.wasm",
  import.meta.url,
);

/**
 * Opens a recording of `size` bytes whose content arrives in `chunks`
 * (concatenated in order), written straight into the reader's memory, so
 * the caller holds no copy of its own. `extension` is the file name's,
 * without the dot.
 */
export const openRecording = async ({
  size,
  chunks,
  extension,
}: {
  size: number;
  chunks: AsyncIterable<Uint8Array>;
  extension: string | null;
}): Promise<Result<OpenedRecording, RecordingRefusedError>> => {
  if (!initialized) {
    return Result.err(
      new RecordingRefusedError({
        refusal: "unreadable",
        message: "The recording reader is not initialized",
      }),
    );
  }
  const bytes = new RecordingBytes(size);
  let offset = 0;
  for await (const chunk of chunks) {
    if (!bytes.write(offset, chunk)) {
      bytes.free();
      return Result.err(refusalOf(new Error("unreadable")));
    }
    offset += chunk.byteLength;
  }
  if (offset !== size) {
    bytes.free();
    return Result.err(refusalOf(new Error("unreadable")));
  }
  // `open` takes ownership of the bytes, whether it succeeds or not.
  const opened = Result.try({
    try: () => RecordingPieces.open(bytes, extension ?? undefined),
    catch: refusalOf,
  });
  return opened.map((pieces) => ({
    format: pieces.format,
    durationMs: pieces.durationMs ?? null,
    next: () =>
      Result.try({
        try: () => {
          const piece = pieces.next();
          if (piece === undefined) {
            return null;
          }
          const read: RecordingPiece = {
            index: piece.index,
            startMs: piece.startMs,
            endMs: piece.endMs,
            pauseBeforeMs: piece.pauseBeforeMs,
            speech: piece.speech,
            wav: piece.takeWav(),
          };
          piece.free();
          return read;
        },
        catch: refusalOf,
      }),
    close: () => pieces.free(),
  }));
};
