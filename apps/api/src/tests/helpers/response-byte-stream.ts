import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Reuses one immutable chunk so boundary tests need not allocate the full body. */
export const responseByteStream = (byteLength: number) => {
  const chunk = new Uint8Array(64 * 1024);
  let remaining = byteLength;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const next = chunk.subarray(0, Math.min(remaining, chunk.byteLength));
      remaining -= next.byteLength;
      controller.enqueue(next);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, wasCancelled: () => cancelled };
};

/** Bun serves files with their actual Content-Length; streams are chunked. */
export const responseByteFile = (byteLength: number) => {
  const directory = mkdtempSync(path.join(tmpdir(), "stella-response-body-"));
  const filename = path.join(directory, "body");
  try {
    const descriptor = openSync(filename, "w");
    try {
      // Sparse zero bytes exercise the published limit without a full heap allocation.
      ftruncateSync(descriptor, byteLength);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    body: Bun.file(filename),
    [Symbol.dispose]() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
};
