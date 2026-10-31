import { panic } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";
import { TransformStream } from "node:stream/web";

export type ReadWork = {
  storageReadBytes: number;
  decryptedBytes: number;
  astParses: number;
  documentConversions: number;
  dbResultBytes: number;
  cacheHits: number;
};

export type QueryCounter = ReadWork & {
  count: number;
  transactions: number;
  fingerprints: Map<string, number>;
  detectRepeatedQueries: boolean;
  countTransactions: boolean;
  diagnostics: boolean;
  parent: QueryCounter | undefined;
  onQuery?: (phase: "work" | "cleanup") => void;
};

export const emptyReadWork = (): ReadWork => ({
  storageReadBytes: 0,
  decryptedBytes: 0,
  astParses: 0,
  documentConversions: 0,
  dbResultBytes: 0,
  cacheHits: 0,
});

const queryCounterStore = new AsyncLocalStorage<QueryCounter>();

/** The request boundary opens one store; SQL and payload telemetry share it. */
export const withRequestWork = <TResult>(
  counter: QueryCounter,
  read: () => TResult,
): TResult => queryCounterStore.run(counter, read);

export const currentRequestWork = (): QueryCounter | undefined =>
  queryCounterStore.getStore();

/** Record work at the owning I/O or transformation boundary, never at callers. */
export const recordReadWork = (metric: keyof ReadWork, amount = 1): void => {
  let counter = queryCounterStore.getStore();
  while (counter !== undefined) {
    counter[metric] += amount;
    counter = counter.parent;
  }
};

/** Detached snapshot: later work cannot alter a captured page's measurements. */
export const currentReadWork = (): Readonly<ReadWork> | undefined => {
  const counter = queryCounterStore.getStore();
  if (counter === undefined) {
    return undefined;
  }
  const {
    storageReadBytes,
    decryptedBytes,
    astParses,
    documentConversions,
    dbResultBytes,
    cacheHits,
  } = counter;
  return Object.freeze({
    storageReadBytes,
    decryptedBytes,
    astParses,
    documentConversions,
    dbResultBytes,
    cacheHits,
  });
};

/** Meter transferred bodies once, below stored-file and corpus adapters. */
export const meterStorageRead = <T extends { byteLength: number }>(
  bytes: T,
): T => {
  recordReadWork("storageReadBytes", bytes.byteLength);
  return bytes;
};

/** UTF-8 JSON payload bytes, excluding driver metadata and protocol framing. */
export const recordDbResult = (rows: unknown): void => {
  if (queryCounterStore.getStore() === undefined) {
    return;
  }
  const serialized = JSON.stringify(rows, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  recordReadWork("dbResultBytes", Buffer.byteLength(serialized || ""));
};

/** Count streamed chunks in the request that opened the object. */
export const meterStorageReadStream = <TChunk>(
  stream: ReadableStream<TChunk>,
) => {
  if (queryCounterStore.getStore() === undefined) {
    return stream;
  }
  const runInCaller = AsyncLocalStorage.snapshot();
  return stream.pipeThrough(
    new TransformStream<TChunk, TChunk>({
      transform: (chunk, controller) => {
        if (!(chunk instanceof Uint8Array)) {
          panic("Storage read stream yielded a non-byte chunk");
        }
        runInCaller(meterStorageRead, chunk);
        controller.enqueue(chunk);
      },
    }),
  );
};
