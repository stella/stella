import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { mockAiCancellationChunks } from "./mock-ai-cancellation";

test("the cancellation fixture stays live until its provider run is stopped", async () => {
  const run = new AbortController();
  const chunks = mockAiCancellationChunks(run.signal);
  expect(await chunks.next()).toEqual({
    done: false,
    value: "This mock reply streams back",
  });
  let ended = false;
  const next = chunks.next();
  void next.then(
    () => {
      ended = true;
      return undefined;
    },
    () => {
      ended = true;
      return undefined;
    },
  );
  await Promise.resolve();
  expect(ended).toBe(false);
  const reason = new DOMException("Stopped", "AbortError");
  run.abort(reason);
  expect(await rejectionOf(next)).toBe(reason);
});

test("a run stopped before the fixture starts emits no answer", async () => {
  const run = new AbortController();
  const reason = new DOMException("Stopped", "AbortError");
  run.abort(reason);
  expect(await rejectionOf(mockAiCancellationChunks(run.signal).next())).toBe(
    reason,
  );
});

test("Stop between the first delta and the next read does not leave a pending wait", async () => {
  const run = new AbortController();
  const chunks = mockAiCancellationChunks(run.signal);
  expect((await chunks.next()).done).toBe(false);
  const reason = new DOMException("Stopped", "AbortError");
  run.abort(reason);
  expect(await rejectionOf(chunks.next())).toBe(reason);
});
