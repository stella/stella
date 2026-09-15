import { QueryClient, queryOptions } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import {
  areArrayBuffersEqual,
  selectStableArrayBuffer,
  shareFileData,
} from "@/lib/files/array-buffer-utils";

const bufferFrom = (values: number[]) => new Uint8Array(values).buffer;

describe("areArrayBuffersEqual", () => {
  test("returns true for byte-identical buffers", () => {
    expect(
      areArrayBuffersEqual(bufferFrom([1, 2, 3]), bufferFrom([1, 2, 3])),
    ).toBeTrue();
  });

  test("returns false for buffers with different bytes", () => {
    expect(
      areArrayBuffersEqual(bufferFrom([1, 2, 3]), bufferFrom([1, 2, 4])),
    ).toBeFalse();
  });

  test("returns false for buffers with different lengths", () => {
    expect(
      areArrayBuffersEqual(bufferFrom([1, 2, 3]), bufferFrom([1, 2])),
    ).toBeFalse();
  });
});

describe("selectStableArrayBuffer", () => {
  test("reuses the stable buffer when bytes match", () => {
    const stableBuffer = bufferFrom([1, 2, 3]);
    const incomingBuffer = bufferFrom([1, 2, 3]);

    expect(selectStableArrayBuffer({ incomingBuffer, stableBuffer })).toBe(
      stableBuffer,
    );
  });

  test("keeps the incoming buffer when bytes differ", () => {
    const stableBuffer = bufferFrom([1, 2, 3]);
    const incomingBuffer = bufferFrom([1, 2, 4]);

    expect(selectStableArrayBuffer({ incomingBuffer, stableBuffer })).toBe(
      incomingBuffer,
    );
  });
});

describe("shareFileData", () => {
  test("keeps cached file references stable through refetches and updates changed bytes", async () => {
    const client = new QueryClient();
    let bytes = [1, 2, 3];
    const options = queryOptions({
      queryKey: ["binary-file-refetch"],
      queryFn: async () => ({
        fileName: "brief.docx",
        buffer: bufferFrom(bytes),
      }),
      structuralSharing: shareFileData,
      staleTime: 0,
    });
    const first = await client.query(options);
    await client.refetchQueries({ queryKey: options.queryKey });
    const repeated = client.getQueryData(options.queryKey);
    expect(repeated).toBe(first);
    expect(repeated?.buffer).toBe(first.buffer);
    bytes = [1, 2, 4];
    await client.refetchQueries({ queryKey: options.queryKey });
    const changed = client.getQueryData(options.queryKey);
    expect(changed?.buffer).not.toBe(first.buffer);
    expect(changed?.buffer).toEqual(bufferFrom(bytes));
    client.clear();
  });

  test("shares unchanged file data across refetches", () => {
    const previous = { fileName: "brief.docx", buffer: bufferFrom([1, 2, 3]) };
    const incoming = {
      fileName: "brief.docx",
      buffer: bufferFrom([1, 2, 3]),
    };
    expect(shareFileData(previous, incoming)).toBe(previous);
  });

  test("propagates changed bytes and metadata", () => {
    const previous = { fileName: "brief.docx", buffer: bufferFrom([1, 2, 3]) };
    expect(
      shareFileData(previous, {
        fileName: "amended.docx",
        buffer: bufferFrom([1, 2, 4]),
      }),
    ).toEqual({ fileName: "amended.docx", buffer: bufferFrom([1, 2, 4]) });
  });
});
