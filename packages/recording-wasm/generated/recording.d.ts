/* tslint:disable */

/**
 * The recording's bytes, written in slices before it is opened.
 */
export class RecordingBytes {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Room for a recording of `length` bytes.
   */
  constructor(length: number);
  /**
   * Copies `slice` in at `offset`; `false` when it does not fit.
   */
  write(offset: number, slice: Uint8Array | number[]): boolean;
}

/**
 * One piece of the recording, ready for a transcription request.
 */
export class RecordingPiece {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * The piece as 16 kHz mono 16-bit PCM WAV; taking it empties the piece.
   */
  takeWav(): Uint8Array;
  readonly endMs: number;
  /**
   * Zero-based, in the order spoken.
   */
  readonly index: number;
  /**
   * The quiet between the previous piece's last word and this one's first.
   */
  readonly pauseBeforeMs: number;
  /**
   * Whether anything in the piece is loud enough to be speech; a silent
   * piece is not worth a request.
   */
  readonly speech: boolean;
  /**
   * Where the piece starts in the recording.
   */
  readonly startMs: number;
}

/**
 * A recording opened for reading, handing out its pieces in order.
 */
export class RecordingPieces {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * The next piece, or `undefined` once the recording ends. Throws
   * `unreadable` or `too_long` as the decoder finds out.
   */
  next(): RecordingPiece | undefined;
  /**
   * Opens the recording. `extension` (without the dot) tells apart
   * containers whose first bytes say the same. Throws an error whose
   * message is `unsupported`, `unreadable`, `too_long` or `dictaphone`.
   */
  static open(
    recording: RecordingBytes,
    extension?: string | null,
  ): RecordingPieces;
  /**
   * The recording's length when its header says, in milliseconds.
   */
  readonly durationMs: number | undefined;
  /**
   * The format's common name (`M4A`, `MP3`, ...).
   */
  readonly format: string;
}

export type InitInput =
  RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_recordingbytes_free: (a: number, b: number) => void;
  readonly __wbg_recordingpiece_free: (a: number, b: number) => void;
  readonly __wbg_recordingpieces_free: (a: number, b: number) => void;
  readonly recordingbytes_new: (a: number) => number;
  readonly recordingbytes_write: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => number;
  readonly recordingpiece_endMs: (a: number) => number;
  readonly recordingpiece_index: (a: number) => number;
  readonly recordingpiece_pauseBeforeMs: (a: number) => number;
  readonly recordingpiece_speech: (a: number) => number;
  readonly recordingpiece_startMs: (a: number) => number;
  readonly recordingpiece_takeWav: (a: number, b: number) => void;
  readonly recordingpieces_durationMs: (a: number, b: number) => void;
  readonly recordingpieces_format: (a: number, b: number) => void;
  readonly recordingpieces_next: (a: number, b: number) => void;
  readonly recordingpieces_open: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => void;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_export: (a: number, b: number) => number;
  readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_export3: (a: number) => void;
  readonly __wbindgen_export4: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => number;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(
  module: { module: SyncInitInput } | SyncInitInput,
): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init(
  module_or_path?:
    | { module_or_path: InitInput | Promise<InitInput> }
    | InitInput
    | Promise<InitInput>,
): Promise<InitOutput>;
