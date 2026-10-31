import { expect, test } from "bun:test";

import { chunksOf, decodeChunkInto } from "./chunks";

test("slices a file into whole chunks and a shorter last one", () => {
  expect(chunksOf(10, 3)).toEqual([
    [0, 3],
    [3, 3],
    [6, 3],
    [9, 1],
  ]);
  expect(chunksOf(6, 3)).toEqual([
    [0, 3],
    [3, 3],
  ]);
  expect(chunksOf(0, 3)).toEqual([]);
});

test("reassembles the bytes from slices decoded independently", () => {
  const bytes = Uint8Array.from({ length: 10 }, (_, index) => index * 25);
  const target = new Uint8Array(bytes.length);
  for (const [offset, length] of chunksOf(bytes.length, 3)) {
    const slice = bytes.subarray(offset, offset + length);
    const written = decodeChunkInto(
      Buffer.from(slice).toString("base64"),
      target,
      offset,
    );
    expect(written).toBe(length);
  }
  expect([...target]).toEqual([...bytes]);
});
