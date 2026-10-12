import { expect, test } from "bun:test";
import { Writable } from "node:stream";

import { forwardTestStderr } from "./test-process-stderr";

test("stderr forwarding waits for a slow destination before consuming the next chunk", async () => {
  const writes: string[] = [];
  const consumed: string[] = [];
  const completions: (() => void)[] = [];
  const destination = new Writable({
    highWaterMark: 1,
    write: (chunk, _encoding, callback) => {
      writes.push(chunk.toString());
      completions.push(() => callback());
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode("a"));
      controller.enqueue(new TextEncoder().encode("b"));
      controller.close();
    },
  });
  const forwarded = forwardTestStderr({
    child: { pid: 42, stderr, exited: Promise.resolve(0) },
    destination,
    onChunk: (chunk) => {
      consumed.push(new TextDecoder().decode(chunk));
    },
    onWarning: (message) => {
      throw new TypeError(message);
    },
  });
  await Bun.sleep(10);
  expect(writes).toEqual(["a"]);
  expect(consumed).toEqual(["a"]);
  completions.shift()?.();
  await Bun.sleep(10);
  expect(writes).toEqual(["a", "b"]);
  expect(consumed).toEqual(["a", "b"]);
  completions.shift()?.();
  expect((await forwarded).isOk()).toBe(true);
});

test("an inherited stderr pipe is cancelled after the exited leader's drain budget", async () => {
  let cancelled = false;
  const stderr = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode("tail"));
    },
    cancel: () => {
      cancelled = true;
    },
  });
  const writes: string[] = [];
  const destination = new Writable({
    write: (chunk, _encoding, callback) => {
      writes.push(chunk.toString());
      callback();
    },
  });
  const result = await forwardTestStderr({
    child: { pid: 42, stderr, exited: Promise.resolve(0) },
    destination,
    onChunk: () => {},
    onWarning: (message) => {
      throw new TypeError(message);
    },
    postExitDrainMs: 20,
  });
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    throw new TypeError("Expected an inherited-pipe drain failure");
  }
  expect(result.error.message).toContain(
    "Test stderr remained open 20ms after PID 42 exited",
  );
  expect(cancelled).toBe(true);
  expect(writes).toEqual(["tail"]);
});
