import { describe, expect, test } from "bun:test";

import { createS3CredentialGuard } from "@/api/lib/s3/credential-guard";
import {
  createMultipartSink,
  multipartPartBytes,
  STREAMING_UPLOAD_MAX_EXPECTED_BYTES,
  STREAMING_UPLOAD_PART_BYTES,
} from "@/api/lib/s3/multipart-sink";

describe("multipart upload sink", () => {
  test("refuses a buffer exceeding the stream budget before starting storage", () => {
    let started = false;
    expect(() =>
      createMultipartSink({
        partBytes: STREAMING_UPLOAD_PART_BYTES + 1,
        start: async () => {
          started = true;
          return "upload";
        },
        sendPart: async () => "etag",
        complete: async () => {},
        putEmpty: async () => {},
      }),
    ).toThrow(
      "Multipart buffer size must be a positive safe integer within the stream budget",
    );
    expect(started).toBe(false);
  });

  test("keeps the buffer fixed and refuses estimates beyond its streaming capacity", () => {
    for (const expectedBytes of [0, 1, STREAMING_UPLOAD_MAX_EXPECTED_BYTES]) {
      expect(multipartPartBytes(expectedBytes)).toBe(
        STREAMING_UPLOAD_PART_BYTES,
      );
    }
    for (const expectedBytes of [
      STREAMING_UPLOAD_MAX_EXPECTED_BYTES + 1,
      Number.MAX_SAFE_INTEGER,
      Number.POSITIVE_INFINITY,
      Number.NaN,
      -1,
      0.5,
    ]) {
      expect(multipartPartBytes(expectedBytes)).toBeNull();
    }
  });

  test("preserves bytes across producer chunk sizes and full, partial, or empty parts", async () => {
    const partBytes = 4;
    for (const length of [0, 1, 4, 8, 11]) {
      for (const chunkBytes of [1, 3, 5, 20]) {
        const source = Uint8Array.from({ length }, (_, index) => index);
        const uploaded: Uint8Array[] = [];
        const completed: { PartNumber: number; ETag: string }[][] = [];
        let starts = 0;
        let emptyPuts = 0;
        const sink = createMultipartSink({
          partBytes,
          start: async () => {
            starts += 1;
            return "upload";
          },
          sendPart: async ({ uploadId, partNumber, data }) => {
            expect(uploadId).toBe("upload");
            expect(partNumber).toBe(uploaded.length + 1);
            expect(data.byteLength).toBeLessThanOrEqual(partBytes);
            uploaded.push(data.slice());
            return `etag-${partNumber}`;
          },
          complete: async ({ uploadId, parts }) => {
            expect(uploadId).toBe("upload");
            completed.push(parts);
          },
          putEmpty: async () => {
            emptyPuts += 1;
          },
        });
        await sink.write(new Uint8Array());
        for (let offset = 0; offset < length; offset += chunkBytes) {
          await sink.write(source.subarray(offset, offset + chunkBytes));
        }
        await sink.end();
        expect(Buffer.concat(uploaded)).toEqual(Buffer.from(source));
        expect(uploaded.map((part) => part.byteLength)).toEqual(
          Array.from({ length: Math.ceil(length / partBytes) }, (_, index) =>
            Math.min(partBytes, length - index * partBytes),
          ),
        );
        expect(starts).toBe(length === 0 ? 0 : 1);
        expect(emptyPuts).toBe(length === 0 ? 1 : 0);
        expect(completed).toEqual(
          length === 0
            ? []
            : [
                uploaded.map((_, index) => ({
                  PartNumber: index + 1,
                  ETag: `etag-${index + 1}`,
                })),
              ],
        );
      }
    }
  });

  test("backpressures the producer until each bounded part finishes uploading", async () => {
    const firstStarted = Promise.withResolvers<undefined>();
    const secondStarted = Promise.withResolvers<undefined>();
    const releaseFirst = Promise.withResolvers<undefined>();
    const releaseSecond = Promise.withResolvers<undefined>();
    const sizes: number[] = [];
    let active = 0;
    let peak = 0;
    let completed = false;
    let written = false;
    const sink = createMultipartSink({
      partBytes: 4,
      start: async () => "upload",
      sendPart: async ({ data, partNumber }) => {
        sizes.push(data.byteLength);
        active += 1;
        peak = Math.max(peak, active);
        if (partNumber === 1) {
          firstStarted.resolve(undefined);
          await releaseFirst.promise;
        } else {
          secondStarted.resolve(undefined);
          await releaseSecond.promise;
        }
        active -= 1;
        return `etag-${partNumber}`;
      },
      complete: async () => {
        completed = true;
      },
      putEmpty: async () => {
        throw new Error("Unexpected empty upload");
      },
    });
    const write = sink.write(new Uint8Array(8)).then(() => {
      written = true;
      return undefined;
    });
    await firstStarted.promise;
    expect(sizes).toEqual([4]);
    expect(written).toBe(false);
    releaseFirst.resolve(undefined);
    await secondStarted.promise;
    expect(sizes).toEqual([4, 4]);
    expect(written).toBe(false);
    expect(completed).toBe(false);
    releaseSecond.resolve(undefined);
    await write;
    expect(peak).toBe(1);
    await sink.end();
    expect(completed).toBe(true);
  });

  test("retains accepted bytes when producers reuse typed arrays or Node buffers", async () => {
    for (const source of [new Uint8Array([1, 2, 3]), Buffer.from([1, 2, 3])]) {
      const uploaded: Uint8Array[] = [];
      const sink = createMultipartSink({
        partBytes: 4,
        start: async () => "upload",
        sendPart: async ({ data }) => {
          uploaded.push(data);
          return "etag";
        },
        complete: async () => {},
        putEmpty: async () => {
          throw new Error("Unexpected empty upload");
        },
      });
      await sink.write(source);
      source.fill(9);
      await sink.write(new Uint8Array([4, 5]));
      await sink.end();
      expect(Buffer.concat(uploaded)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    }
  });

  test("refreshes rotating clients between multipart requests without replaying accepted parts", async () => {
    let now = 0;
    let client = { generation: 0, expiresAt: 0 };
    const requests: { operation: string; generation: number }[] = [];
    const credentials = createS3CredentialGuard({
      isStale: () => now >= client.expiresAt,
      refresh: async () => {
        client = { generation: client.generation + 1, expiresAt: now + 1 };
      },
    });
    const request = async (operation: string) =>
      await credentials.run(async () => {
        expect(client.expiresAt).toBeGreaterThan(now);
        requests.push({ operation, generation: client.generation });
        now += 1;
        return operation;
      });
    const sink = createMultipartSink({
      partBytes: 2,
      start: async () => await request("start"),
      sendPart: async ({ uploadId, partNumber }) => {
        expect(uploadId).toBe("start");
        return await request(`part-${partNumber}`);
      },
      complete: async ({ parts }) => {
        expect(parts).toEqual([
          { PartNumber: 1, ETag: "part-1" },
          { PartNumber: 2, ETag: "part-2" },
        ]);
        await request("complete");
      },
      putEmpty: async () => {
        throw new Error("Unexpected empty upload");
      },
    });
    await sink.write(new Uint8Array([1, 2, 3]));
    await sink.end();
    expect(requests).toEqual([
      { operation: "start", generation: 1 },
      { operation: "part-1", generation: 2 },
      { operation: "part-2", generation: 3 },
      { operation: "complete", generation: 4 },
    ]);
  });
});
