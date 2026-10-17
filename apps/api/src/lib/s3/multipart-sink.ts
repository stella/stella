import { panic } from "better-result";

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
  if (!Number.isSafeInteger(partBytes) || partBytes <= 0) {
    return panic("Multipart buffer size must be a positive safe integer");
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
