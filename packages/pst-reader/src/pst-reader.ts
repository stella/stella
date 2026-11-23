import { existsSync, readFileSync } from "node:fs";

import {
  initSync,
  open_pst_mailbox,
  type WasmPstMailbox,
  type WasmPstOutcome,
} from "../generated/pst_reader.js";
import {
  decodePstListing,
  decodePstMessage,
  type PstListing,
  type PstMessage,
} from "./wire";

export * from "./wire";

/** File name of the WebAssembly module, which a bundle ships beside itself. */
export const PST_READER_WASM_FILE = "pst_reader_bg.wasm";

/**
 * Where the module is: beside the running file when this code is bundled
 * (the host copies it there, as it does other WebAssembly sidecars), else in
 * this package's `generated/` directory.
 */
export const pstReaderWasmUrl = (): URL => {
  const sidecar = new URL(PST_READER_WASM_FILE, import.meta.url);
  return existsSync(sidecar)
    ? sidecar
    : new URL(`../generated/${PST_READER_WASM_FILE}`, import.meta.url);
};

/**
 * What reading one mailbox may take. Each operation (opening, the list, one
 * message) starts with its own budget of bytes and host reads.
 */
export type PstReaderLimits = {
  /** Messages the list gives; a mailbox with more is `truncated`. */
  readonly maxMessages: number;
  /**
   * The largest message read, as returned (properties, bodies and
   * attachments); a larger one is refused as `too-large`.
   */
  readonly maxMessageBytes: number;
  /** Bytes opening the mailbox and walking its folders may read. */
  readonly maxWalkBytes: number;
  /** Bytes reading one message may read, its walk aside. */
  readonly maxMessageReadBytes: number;
  /** Reads from the file one operation may make. */
  readonly maxReads: number;
  /** Folders the walk opens; past them the list is `truncated`. */
  readonly maxFolders: number;
  /** How deep below the top folder the walk goes. */
  readonly maxFolderDepth: number;
  /** Recipients a message gives. */
  readonly maxRecipients: number;
  /** Attachments a message gives; it says when it has more. */
  readonly maxAttachments: number;
};

/**
 * The mailbox file, read at an offset: `readAt` fills `buffer` from
 * `offset` and returns how many bytes it read (fewer only at the end of the
 * file), or -1 to stop the operation (a read that failed, or a deadline).
 */
export type PstHostFile = {
  readonly size: number;
  readonly readAt: (offset: number, buffer: Uint8Array) => number;
};

/**
 * - `unreadable`: not a PST file the reader reads, or a damaged one.
 * - `no-message`: the list has no message at that position.
 * - `too-large`: the message is over its bounds.
 * - `exhausted`: the operation made as many reads as it may, or the file
 *   stopped it (its deadline).
 * - `failed`: the reader stopped (its memory limit, or a defect in it); its
 *   instance is discarded and the next mailbox opens in a fresh one.
 */
export type PstRefusal =
  | { type: "unreadable" }
  | { type: "no-message" }
  | { type: "too-large" }
  | { type: "exhausted" }
  | { type: "failed"; message: string };

export type PstRead<T> = { type: "read"; value: T } | PstRefusal;

export type PstMailbox = {
  /** The mailbox's folders and messages, in walk order. */
  list: () => PstRead<PstListing>;
  /** The message at `index` in the list. */
  message: (index: number) => PstRead<PstMessage>;
  /** Releases the mailbox's memory in the module. */
  close: () => void;
};

const refusal = (status: string): PstRefusal => {
  switch (status) {
    case "unreadable":
    case "no-message":
    case "too-large":
    case "exhausted":
      return { type: status };
    default:
      return { type: "failed", message: `Unknown reader status: ${status}` };
  }
};

const limitValues = (limits: PstReaderLimits): Float64Array =>
  Float64Array.from([
    limits.maxMessages,
    limits.maxMessageBytes,
    limits.maxWalkBytes,
    limits.maxMessageReadBytes,
    limits.maxReads,
    limits.maxFolders,
    limits.maxFolderDepth,
    limits.maxRecipients,
    limits.maxAttachments,
  ]);

export type PstReader = {
  /**
   * Opens the mailbox in `file`. Reading is synchronous and single-threaded:
   * run it where blocking is fine (a worker process), never on a request
   * path.
   */
  open: (file: PstHostFile, limits: PstReaderLimits) => PstRead<PstMailbox>;
};

/**
 * The module's one instance in this process. The generated bindings keep the
 * instance's exports in a single module-scoped binding, so every reader
 * shares it: a trap discards it for all of them, and each mailbox remembers
 * the instance (generation) that opened it.
 */
const instance = {
  generation: 0,
  loaded: false,
  /** Mailboxes open in the current instance. */
  open: new Set<WasmPstMailbox>(),
};

/**
 * Forgets `mailbox` without calling into the module: its pointer belongs to
 * an instance that trapped, and freeing it (now or from the bindings'
 * finaliser) would reach the instance that replaced it.
 */
/** The bindings' own release of a handle: it unregisters the finaliser. */
type Destroyable = { readonly __destroy_into_raw: () => number };

const isDestroyable = (handle: object): handle is Destroyable =>
  "__destroy_into_raw" in handle &&
  typeof handle.__destroy_into_raw === "function";

const forget = (mailbox: WasmPstMailbox) => {
  if (isDestroyable(mailbox)) {
    mailbox.__destroy_into_raw();
  }
};

/** A trap leaves the instance's memory in an unknown state: it is discarded. */
const discardInstance = () => {
  instance.loaded = false;
  for (const mailbox of instance.open) {
    forget(mailbox);
  }
  instance.open.clear();
};

/**
 * A reader backed by the WebAssembly module at `wasmPath` (by default
 * `pstReaderWasmUrl()`), loaded on the first call. Readers share the
 * process's one instance; the first to load it names the file.
 */
export const createPstReader = (
  wasmPath: string | URL = pstReaderWasmUrl(),
): PstReader => {
  const load = () => {
    if (!instance.loaded) {
      initSync({ module: readFileSync(wasmPath) });
      instance.loaded = true;
      instance.generation += 1;
    }
  };
  const guarded = <T>(read: () => PstRead<T>): PstRead<T> => {
    try {
      return read();
    } catch (error) {
      if (!(error instanceof WebAssembly.RuntimeError)) {
        throw error;
      }
      discardInstance();
      return { type: "failed", message: error.message };
    }
  };
  const outcome = <T>(
    take: () => WasmPstOutcome,
    decode: (bytes: Uint8Array) => T | null,
  ): PstRead<T> => {
    const result = take();
    try {
      if (result.status !== "read") {
        return refusal(result.status);
      }
      const value = decode(result.take_bytes());
      return value === null
        ? { type: "failed", message: "The reader's output did not decode" }
        : { type: "read", value };
    } finally {
      result.free();
    }
  };
  return {
    open: (file, limits) =>
      guarded(() => {
        load();
        const generation = instance.generation;
        const mailbox: WasmPstMailbox = open_pst_mailbox(
          file,
          file.size,
          limitValues(limits),
        );
        if (mailbox.status !== "opened") {
          const status = mailbox.status;
          mailbox.free();
          return refusal(status);
        }
        instance.open.add(mailbox);
        const live = () =>
          instance.loaded &&
          instance.generation === generation &&
          instance.open.has(mailbox);
        const gone = (): PstRefusal => ({
          type: "failed",
          message: "The reader stopped while this mailbox was open",
        });
        return {
          type: "read",
          value: {
            list: () =>
              live()
                ? guarded(() => outcome(() => mailbox.list(), decodePstListing))
                : gone(),
            message: (index) =>
              live()
                ? guarded(() =>
                    outcome(() => mailbox.message(index), decodePstMessage),
                  )
                : gone(),
            close: () => {
              if (live()) {
                instance.open.delete(mailbox);
                mailbox.free();
              }
            },
          },
        };
      }),
  };
};
