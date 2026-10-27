import { expect, test } from "bun:test";

import { deriveApiTestWorkerCount } from "./test-worker-count";

const GIB = 1024 * 1024 * 1024;

test("memory bounds workers on a many-core low-memory runner", () => {
  expect(
    deriveApiTestWorkerCount({
      availableParallelism: 16,
      totalMemoryBytes: 7 * GIB,
    }),
  ).toBe(2);
});

test("cores bound workers on a few-core high-memory runner", () => {
  expect(
    deriveApiTestWorkerCount({
      availableParallelism: 4,
      totalMemoryBytes: 64 * GIB,
    }),
  ).toBe(3);
});

test("worker count never falls below one", () => {
  expect(
    deriveApiTestWorkerCount({
      availableParallelism: 1,
      totalMemoryBytes: 1024,
    }),
  ).toBe(1);
});
