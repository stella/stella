/* tslint:disable */

export class WasmHeicPreview {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * The pixels, moved out: a second call returns none.
   */
  take_rgba(): Uint8Array;
  readonly height: number;
  /**
   * `decoded`, or the refusal: `too-large` or `unreadable`.
   */
  readonly status: string;
  readonly width: number;
}

/**
 * Pixel limits are passed as `f64` (JavaScript numbers) and must be whole
 * and positive; anything else is a caller defect.
 */
export function decode_heic_preview(
  bytes: Uint8Array | number[],
  max_decoded_pixels: number,
  max_canvas_pixels: number,
  max_output_pixels: number,
): WasmHeicPreview;

export type InitInput =
  RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_wasmheicpreview_free: (a: number, b: number) => void;
  readonly decode_heic_preview: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ) => void;
  readonly wasmheicpreview_height: (a: number) => number;
  readonly wasmheicpreview_status: (a: number, b: number) => void;
  readonly wasmheicpreview_take_rgba: (a: number, b: number) => void;
  readonly wasmheicpreview_width: (a: number) => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_export: (a: number, b: number) => number;
  readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
  readonly __wbindgen_export3: (a: number) => void;
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
