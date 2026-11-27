import { Result, TaggedError } from "better-result";
import { existsSync } from "node:fs";

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

const REFUSALS: ReadonlySet<string> = new Set(RECORDING_REFUSALS);
const isRefusal = (value: string): value is RecordingRefusal =>
  REFUSALS.has(value);

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

/** File name of the WebAssembly module, which a bundle ships beside itself. */
export const RECORDING_WASM_FILE = "recording_bg.wasm";

/** Where the compiled reader lives, next to this file's generated glue. */
export const RECORDING_WASM_URL = new URL(
  `../generated/${RECORDING_WASM_FILE}`,
  import.meta.url,
);

/**
 * Where the module is: beside the running file when this code is bundled
 * (the host copies it there, as it does other WebAssembly sidecars), else in
 * this package's `generated/` directory.
 */
export const recordingWasmUrl = (): URL => {
  const sidecar = new URL(RECORDING_WASM_FILE, import.meta.url);
  return existsSync(sidecar) ? sidecar : RECORDING_WASM_URL;
};

/**
 * Opens a recording of `size` bytes whose content is `chunks` (concatenated
 * in order), written straight into the reader's memory, so the caller can
 * drop its own copy chunk by chunk. `extension` is the file name's, without
 * the dot. Synchronous: run it off the main thread.
 */
export const openRecording = ({
  size,
  chunks,
  extension,
}: {
  size: number;
  chunks: Iterable<Uint8Array>;
  extension: string | null;
}): Result<OpenedRecording, RecordingRefusedError> => {
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
  for (const chunk of chunks) {
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
