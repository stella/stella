import { describe, expect, test } from "bun:test";

import {
  areArrayBuffersEqual,
  selectStableArrayBuffer,
} from "./array-buffer-utils";

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
