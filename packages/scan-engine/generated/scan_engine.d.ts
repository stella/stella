/* tslint:disable */

export class WasmScanResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly applied_quad: Float32Array;
  readonly content_box: Uint32Array;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly reason: string;
  readonly skew_degrees: number;
  readonly status: string;
  readonly width: number;
}

export function clean_scan_rgba(
  width: number,
  height: number,
  pixels: Uint8Array,
  dpi: number,
  output: string,
  content_crop: boolean,
  deskew: boolean,
): WasmScanResult;

export type InitInput =
  | RequestInfo
  | URL
  | Response
  | BufferSource
  | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_wasmscanresult_free: (a: number, b: number) => void;
  readonly wasmscanresult_status: (a: number, b: number) => void;
  readonly wasmscanresult_reason: (a: number, b: number) => void;
  readonly wasmscanresult_pixels: (a: number, b: number) => void;
  readonly wasmscanresult_content_box: (a: number, b: number) => void;
  readonly wasmscanresult_applied_quad: (a: number, b: number) => void;
  readonly clean_scan_rgba: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number,
  ) => void;
  readonly wasmscanresult_width: (a: number) => number;
  readonly wasmscanresult_height: (a: number) => number;
  readonly wasmscanresult_skew_degrees: (a: number) => number;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_export: (a: number, b: number) => number;
  readonly __wbindgen_export2: (
    a: number,
    b: number,
    c: number,
    d: number,
  ) => number;
  readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
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
