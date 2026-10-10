import { expect, test } from "bun:test";

import {
  cloneOperationInput,
  snapshotOperationInput,
} from "@/api/lib/proofs/checked-transaction";

test("checked snapshots and execution copies own their file bytes", () => {
  const buffer = Buffer.from([1, 2, 3]);
  const bytes = new Uint8Array([4, 5, 6]);
  const input = { buffer, bytes, again: buffer };

  const snapshot = snapshotOperationInput(input);
  const execution = cloneOperationInput(snapshot);
  buffer[0] = 9;
  bytes[0] = 9;
  execution.buffer[1] = 8;

  expect(Buffer.isBuffer(snapshot.buffer)).toBe(true);
  expect([...snapshot.buffer]).toEqual([1, 2, 3]);
  expect([...snapshot.bytes]).toEqual([4, 5, 6]);
  expect(snapshot.again).toBe(snapshot.buffer);
  expect(Buffer.isBuffer(execution.buffer)).toBe(true);
  expect([...execution.buffer]).toEqual([1, 8, 3]);
});
