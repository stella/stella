import { Result } from "better-result";

import type { RecordingPiece, RecordingRefusal } from "@stll/recording-wasm";

import {
  resolveRuntimeWorkerPath,
  RUNTIME_WORKER_FILES,
} from "@/api/lib/runtime-worker-path";

import type {
  RecordingReaderMessage,
  RecordingReaderReply,
} from "./recording-reader-protocol";

export type RecordingReader = {
  durationMs: number | null;
  next: () => Promise<Result<RecordingPiece | null, RecordingRefusal>>;
  close: () => Promise<void>;
};

const exchange = async (
  worker: Worker,
  message: RecordingReaderMessage,
  transfer: ArrayBuffer[] = [],
): Promise<RecordingReaderReply> =>
  await new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<RecordingReaderReply>) => {
      worker.removeEventListener("error", onError);
      resolve(event.data);
    };
    const onError = (event: ErrorEvent) => {
      worker.removeEventListener("message", onMessage);
      reject(
        event.error instanceof Error ? event.error : new Error(event.message),
      );
    };
    worker.addEventListener("message", onMessage, { once: true });
    worker.addEventListener("error", onError, { once: true });
    worker.postMessage(message, transfer);
  });

/**
 * Opens a recording in its own worker thread, which decodes one piece each
 * time `next` asks for it. The bytes are handed to the worker, not copied.
 */
export const openRecordingReader = async ({
  bytes,
  extension,
}: {
  bytes: ArrayBuffer;
  extension: string | null;
}): Promise<Result<RecordingReader, RecordingRefusal>> => {
  const worker = new Worker(
    resolveRuntimeWorkerPath({
      outputFile: RUNTIME_WORKER_FILES.recordingReader,
      sourceDir: import.meta.dir,
      sourceFile: "recording-reader-worker.ts",
    }),
  );
  const close = async () => {
    worker.terminate();
    await Promise.resolve();
  };
  const opened = await Result.tryPromise({
    try: async () =>
      await exchange(worker, { type: "open", bytes, extension }, [bytes]),
    catch: () => "unreadable" as const,
  });
  if (Result.isError(opened)) {
    await close();
    return Result.err(opened.error);
  }
  if (opened.value.type !== "opened") {
    await close();
    return Result.err(
      opened.value.type === "refused" ? opened.value.refusal : "unreadable",
    );
  }
  return Result.ok({
    durationMs: opened.value.durationMs,
    next: async () => {
      const read = await Result.tryPromise({
        try: async () => await exchange(worker, { type: "next" }),
        catch: () => "unreadable" as const,
      });
      if (Result.isError(read)) {
        return Result.err(read.error);
      }
      if (read.value.type === "piece") {
        return Result.ok(read.value.piece);
      }
      if (read.value.type === "end") {
        return Result.ok(null);
      }
      return Result.err(
        read.value.type === "refused" ? read.value.refusal : "unreadable",
      );
    },
    close,
  });
};
