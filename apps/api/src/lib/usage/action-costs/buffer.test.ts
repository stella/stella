import { expect, test } from "bun:test";

import { createObservationBuffer } from "./buffer";

test("buffer capacity includes the active batch and drains later writes on flush", async () => {
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const written: number[] = [];
  let dropped = 0;
  const buffer = createObservationBuffer({
    capacity: 3,
    batchSize: 2,
    write: async (batch: number[]) => {
      await blocked;
      written.push(...batch);
    },
    onFailure: () => {
      throw new TypeError("unexpected write failure");
    },
    onOverflow: () => {
      dropped += 1;
    },
  });
  buffer.enqueue(1);
  buffer.enqueue(2);
  const flushing = buffer.flush();
  buffer.enqueue(3);
  buffer.enqueue(4);
  release();
  await Promise.all([flushing, buffer.flush()]);
  expect(written).toEqual([1, 2, 3]);
  expect(dropped).toBe(1);
  buffer.enqueue(5);
  await buffer.flush();
  expect(written).toEqual([1, 2, 3, 5]);
});
