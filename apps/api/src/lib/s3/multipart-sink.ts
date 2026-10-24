import { panic } from "better-result";

export const MULTIPART_MAX_PARTS = 10_000;
/** Fixed per-stream buffering budget, including uploads of large objects. */
export const STREAMING_UPLOAD_PART_BYTES = 16 * 1024 * 1024;
/** Leave room for an object's actual size to exceed its estimate. */
const STREAMING_UPLOAD_SIZE_HEADROOM = 2;
export const STREAMING_UPLOAD_MAX_EXPECTED_BYTES = Math.floor(
  (STREAMING_UPLOAD_PART_BYTES * MULTIPART_MAX_PARTS) /
    STREAMING_UPLOAD_SIZE_HEADROOM,
);

/** Refuse objects that cannot fit the provider limit within the buffer budget. */
export const multipartPartBytes = (expectedBytes: number): number | null => {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    return null;
  }
  return expectedBytes <= STREAMING_UPLOAD_MAX_EXPECTED_BYTES
    ? STREAMING_UPLOAD_PART_BYTES
    : null;
};

type CompletedPart = { PartNumber: number; ETag: string };

type MultipartSinkOptions = {
  partBytes: number;
  start: () => Promise<string>;
  sendPart: (part: {
    uploadId: string;
    partNumber: number;
    data: Uint8Array;
  }) => Promise<string>;
  complete: (upload: {
    uploadId: string;
    parts: CompletedPart[];
  }) => Promise<void>;
  putEmpty: () => Promise<void>;
};

/** Each network call is separate so its owner can refresh credentials on retry. */
export const createMultipartSink = ({
  partBytes,
  start,
  sendPart,
  complete,
  putEmpty,
}: MultipartSinkOptions) => {
  if (
    !Number.isSafeInteger(partBytes) ||
    partBytes <= 0 ||
    partBytes > STREAMING_UPLOAD_PART_BYTES
  ) {
    return panic(
      "Multipart buffer size must be a positive safe integer within the stream budget",
    );
  }
  let uploadId: string | null = null;
  let chunks: Uint8Array[] = [];
  let bufferedBytes = 0;
  let status: "open" | "closed" = "open";
  const parts: CompletedPart[] = [];
  const flush = async () => {
    const partNumber = parts.length + 1;
    uploadId ??= await start();
    const data = Buffer.concat(chunks, bufferedBytes);
    const etag = await sendPart({ uploadId, partNumber, data });
    parts.push({ PartNumber: partNumber, ETag: etag });
    chunks = [];
    bufferedBytes = 0;
  };
  return {
    write: async (chunk: Uint8Array): Promise<void> => {
      if (status !== "open") {
        return panic("Cannot write to a completed multipart upload");
      }
      for (let offset = 0; offset < chunk.byteLength;) {
        const length = Math.min(
          partBytes - bufferedBytes,
          chunk.byteLength - offset,
        );
        // Copy accepted bytes: the producer may reuse its buffer after write.
        chunks.push(Uint8Array.from(chunk.subarray(offset, offset + length)));
        bufferedBytes += length;
        offset += length;
        if (bufferedBytes === partBytes) {
          await flush();
        }
      }
    },
    end: async (): Promise<void> => {
      if (status !== "open") {
        return panic("Cannot complete a multipart upload twice");
      }
      status = "closed";
      if (bufferedBytes > 0) {
        await flush();
      }
      if (uploadId === null) {
        await putEmpty();
        return;
      }
      await complete({ uploadId, parts });
    },
  };
};
