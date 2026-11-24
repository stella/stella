/* tslint:disable */

export class WasmPstMailbox {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  list(): WasmPstOutcome;
  message(index: number): WasmPstOutcome;
  /**
   * `opened`, or the refusal's code.
   */
  readonly status: string;
}

/**
 * The outcome of one operation: `read`, or the refusal's code.
 */
export class WasmPstOutcome {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * The listing or the message (`wire`), moved out: a second call
   * returns none.
   */
  take_bytes(): Uint8Array;
  readonly status: string;
}

/**
 * Limits are passed as JavaScript numbers, in [`Limits`] field order, and
 * must be whole and positive; anything else is a caller defect.
 */
export function open_pst_mailbox(
  file: any,
  size: number,
  limits: Float64Array | number[],
): WasmPstMailbox;

export type InitInput =
  RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_wasmpstmailbox_free: (a: number, b: number) => void;
  readonly __wbg_wasmpstoutcome_free: (a: number, b: number) => void;
  readonly open_pst_mailbox: (
    a: number,
    b: any,
    c: number,
    d: number,
    e: number,
  ) => void;
  readonly wasmpstmailbox_list: (a: number) => number;
  readonly wasmpstmailbox_message: (a: number, b: number) => number;
  readonly wasmpstmailbox_status: (a: number, b: number) => void;
  readonly wasmpstoutcome_status: (a: number, b: number) => void;
  readonly wasmpstoutcome_take_bytes: (a: number, b: number) => void;
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
