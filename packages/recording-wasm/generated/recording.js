/* @ts-self-types="./recording.d.ts" */

/**
 * The recording's bytes, written in slices before it is opened.
 */
export class RecordingBytes {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    RecordingBytesFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_recordingbytes_free(ptr, 0);
  }
  /**
   * Room for a recording of `length` bytes.
   * @param {number} length
   */
  constructor(length) {
    const ret = wasm.recordingbytes_new(length);
    this.__wbg_ptr = ret;
    RecordingBytesFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
  /**
   * Copies `slice` in at `offset`; `false` when it does not fit.
   * @param {number} offset
   * @param {Uint8Array | number[]} slice
   * @returns {boolean}
   */
  write(offset, slice) {
    const val2 = +offset;
    const ptr0 = passArray8ToWasm0(slice, wasm.__wbindgen_export);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.recordingbytes_write(this.__wbg_ptr, val2, ptr0, len0);
    return ret !== 0;
  }
}
if (Symbol.dispose)
  RecordingBytes.prototype[Symbol.dispose] = RecordingBytes.prototype.free;

/**
 * One piece of the recording, ready for a transcription request.
 */
export class RecordingPiece {
  static __wrap(ptr) {
    const obj = Object.create(RecordingPiece.prototype);
    obj.__wbg_ptr = ptr;
    RecordingPieceFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    RecordingPieceFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_recordingpiece_free(ptr, 0);
  }
  /**
   * @returns {number}
   */
  get endMs() {
    const ret = wasm.recordingpiece_endMs(this.__wbg_ptr);
    return ret;
  }
  /**
   * Zero-based, in the order spoken.
   * @returns {number}
   */
  get index() {
    const ret = wasm.recordingpiece_index(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * The quiet between the previous piece's last word and this one's first.
   * @returns {number}
   */
  get pauseBeforeMs() {
    const ret = wasm.recordingpiece_pauseBeforeMs(this.__wbg_ptr);
    return ret;
  }
  /**
   * Whether anything in the piece is loud enough to be speech; a silent
   * piece is not worth a request.
   * @returns {boolean}
   */
  get speech() {
    const ret = wasm.recordingpiece_speech(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * Where the piece starts in the recording.
   * @returns {number}
   */
  get startMs() {
    const ret = wasm.recordingpiece_startMs(this.__wbg_ptr);
    return ret;
  }
  /**
   * The piece as 16 kHz mono 16-bit PCM WAV; taking it empties the piece.
   * @returns {Uint8Array}
   */
  takeWav() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
      wasm.recordingpiece_takeWav(retptr, this.__wbg_ptr);
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
      var v1 = getArrayU8FromWasm0(r0, r1).slice();
      wasm.__wbindgen_export2(r0, r1 * 1, 1);
      return v1;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
}
if (Symbol.dispose)
  RecordingPiece.prototype[Symbol.dispose] = RecordingPiece.prototype.free;

/**
 * A recording opened for reading, handing out its pieces in order.
 */
export class RecordingPieces {
  static __wrap(ptr) {
    const obj = Object.create(RecordingPieces.prototype);
    obj.__wbg_ptr = ptr;
    RecordingPiecesFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    RecordingPiecesFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_recordingpieces_free(ptr, 0);
  }
  /**
   * The recording's length when its header says, in milliseconds.
   * @returns {number | undefined}
   */
  get durationMs() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
      wasm.recordingpieces_durationMs(retptr, this.__wbg_ptr);
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
      var r2 = getDataViewMemory0().getFloat64(retptr + 8 * 1, true);
      return r0 === 0 ? undefined : r2;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
  /**
   * The format's common name (`M4A`, `MP3`, ...).
   * @returns {string}
   */
  get format() {
    let deferred1_0;
    let deferred1_1;
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
      wasm.recordingpieces_format(retptr, this.__wbg_ptr);
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
      deferred1_0 = r0;
      deferred1_1 = r1;
      return getStringFromWasm0(r0, r1);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
      wasm.__wbindgen_export2(deferred1_0, deferred1_1, 1);
    }
  }
  /**
   * The next piece, or `undefined` once the recording ends. Throws
   * `unreadable` or `too_long` as the decoder finds out.
   * @returns {RecordingPiece | undefined}
   */
  next() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
      wasm.recordingpieces_next(retptr, this.__wbg_ptr);
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
      if (r2) {
        throw takeFromExternrefTable0(r1);
      }
      return r0 === 0 ? undefined : RecordingPiece.__wrap(r0);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
  /**
   * Opens the recording. `extension` (without the dot) tells apart
   * containers whose first bytes say the same. Throws an error whose
   * message is `unsupported`, `unreadable`, `too_long` or `dictaphone`.
   * @param {RecordingBytes} recording
   * @param {string | null} [extension]
   * @returns {RecordingPieces}
   */
  static open(recording, extension) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
      let ptr0, ptr1, len1;
      try {
        _assertClass(recording, RecordingBytes);
        ptr0 = recording.__destroy_into_raw();
        ptr1 = isLikeNone(extension)
          ? 0
          : passStringToWasm0(
              extension,
              wasm.__wbindgen_export,
              wasm.__wbindgen_export4,
            );
        len1 = WASM_VECTOR_LEN;
      } catch (e) {
        if (ptr1) {
          wasm.__wbindgen_export2(ptr1, len1 * 1, 1);
        }
        if (ptr0) wasm.__wbg_recordingbytes_free(ptr0, 1);
        throw e;
      }
      wasm.recordingpieces_open(retptr, ptr0, ptr1, len1);
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
      if (r2) {
        throw takeFromExternrefTable0(r1);
      }
      return RecordingPieces.__wrap(r0);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
}
if (Symbol.dispose)
  RecordingPieces.prototype[Symbol.dispose] = RecordingPieces.prototype.free;
function __wbg_get_imports() {
  const import0 = {
    __proto__: null,
    __wbg_Error_208446807d0d1e30: function (arg0, arg1) {
      const ret = Error(getStringFromWasm0(arg0, arg1));
      return ret;
    },
    __wbg___wbindgen_throw_4c88d8bf264fd984: function (arg0, arg1) {
      throw new Error(getStringFromWasm0(arg0, arg1));
    },
    __wbindgen_init_externref_table: function () {
      const table = wasm.__wbindgen_externrefs;
      table.set(0, undefined);
      table.set(1024, undefined);
      table.set(1025, null);
      table.set(1026, true);
      table.set(1027, false);
    },
  };
  return {
    __proto__: null,
    "./recording_bg.js": import0,
  };
}

const RecordingBytesFinalization =
  typeof FinalizationRegistry === "undefined"
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry((ptr) => wasm.__wbg_recordingbytes_free(ptr, 1));
const RecordingPieceFinalization =
  typeof FinalizationRegistry === "undefined"
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry((ptr) => wasm.__wbg_recordingpiece_free(ptr, 1));
const RecordingPiecesFinalization =
  typeof FinalizationRegistry === "undefined"
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry((ptr) =>
        wasm.__wbg_recordingpieces_free(ptr, 1),
      );

function _assertClass(instance, klass) {
  if (!(instance instanceof klass)) {
    throw new Error(`expected instance of ${klass.name}`);
  }
}

function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
  if (
    cachedDataViewMemory0 === null ||
    cachedDataViewMemory0.buffer.detached === true ||
    (cachedDataViewMemory0.buffer.detached === undefined &&
      cachedDataViewMemory0.buffer !== wasm.memory.buffer)
  ) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
  }
  return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return decodeText(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (
    cachedUint8ArrayMemory0 === null ||
    cachedUint8ArrayMemory0.byteLength === 0
  ) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
  return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 1, 1) >>> 0;
  getUint8ArrayMemory0().set(arg, ptr / 1);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === undefined) {
    const buf = cachedTextEncoder.encode(arg);
    const ptr = malloc(buf.length, 1) >>> 0;
    getUint8ArrayMemory0()
      .subarray(ptr, ptr + buf.length)
      .set(buf);
    WASM_VECTOR_LEN = buf.length;
    return ptr;
  }

  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;

  const mem = getUint8ArrayMemory0();

  let offset = 0;

  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 0x7f) break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset);
    }
    ptr = realloc(ptr, len, (len = offset + arg.length * 3), 1) >>> 0;
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
    const ret = cachedTextEncoder.encodeInto(arg, view);

    offset += ret.written;
    ptr = realloc(ptr, len, offset, 1) >>> 0;
  }

  WASM_VECTOR_LEN = offset;
  return ptr;
}

function takeFromExternrefTable0(idx) {
  const value = wasm.__wbindgen_externrefs.get(idx);
  wasm.__wbindgen_export3(idx);
  return value;
}

let cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(bytes) {
  numBytesDecoded += bytes.length;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
    cachedTextDecoder.decode();
    numBytesDecoded = bytes.length;
  }
  return cachedTextDecoder.decode(bytes);
}

const cachedTextEncoder = new TextEncoder();

if (!("encodeInto" in cachedTextEncoder)) {
  cachedTextEncoder.encodeInto = function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
      read: arg.length,
      written: buf.length,
    };
  };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
  wasmInstance = instance;
  wasm = instance.exports;
  wasmModule = module;
  cachedDataViewMemory0 = null;
  cachedUint8ArrayMemory0 = null;
  wasm.__wbindgen_start();
  return wasm;
}

async function __wbg_load(module, imports) {
  if (typeof Response === "function" && module instanceof Response) {
    if (!module.ok) {
      throw new Error(
        `failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`,
      );
    }

    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e) {
        const validResponse = expectedResponseType(module.type);

        if (
          validResponse &&
          module.headers.get("Content-Type") !== "application/wasm"
        ) {
          console.warn(
            "`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n",
            e,
          );
        } else {
          throw e;
        }
      }
    }

    const bytes = await module.arrayBuffer();
    return await WebAssembly.instantiate(bytes, imports);
  } else {
    const instance = await WebAssembly.instantiate(module, imports);

    if (instance instanceof WebAssembly.Instance) {
      return { instance, module };
    } else {
      return instance;
    }
  }

  function expectedResponseType(type) {
    switch (type) {
      case "basic":
      case "cors":
      case "default":
        return true;
    }
    return false;
  }
}

function initSync(module) {
  if (wasm !== undefined) return wasm;

  if (module !== undefined) {
    if (Object.getPrototypeOf(module) === Object.prototype) {
      ({ module } = module);
    } else {
      console.warn(
        "using deprecated parameters for `initSync()`; pass a single object instead",
      );
    }
  }

  const imports = __wbg_get_imports();
  if (!(module instanceof WebAssembly.Module)) {
    module = new WebAssembly.Module(module);
  }
  const instance = new WebAssembly.Instance(module, imports);
  return __wbg_finalize_init(instance, module);
}

let __wbg_init_promise;
async function __wbg_init(module_or_path) {
  if (wasm !== undefined) return wasm;
  if (__wbg_init_promise === undefined) {
    __wbg_init_promise = __wbg_init_once(module_or_path);
    __wbg_init_promise.catch(() => {
      __wbg_init_promise = undefined;
    });
  }
  return __wbg_init_promise;
}

async function __wbg_init_once(module_or_path) {
  if (module_or_path !== undefined) {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ({ module_or_path } = module_or_path);
    } else {
      console.warn(
        "using deprecated parameters for the initialization function; pass a single object instead",
      );
    }
  }

  if (module_or_path === undefined) {
    module_or_path = new URL("recording_bg.wasm", import.meta.url);
  }
  const imports = __wbg_get_imports();

  if (
    typeof module_or_path === "string" ||
    (typeof Request === "function" && module_or_path instanceof Request) ||
    (typeof URL === "function" && module_or_path instanceof URL)
  ) {
    module_or_path = fetch(module_or_path);
  }

  const { instance, module } = await __wbg_load(await module_or_path, imports);

  return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
