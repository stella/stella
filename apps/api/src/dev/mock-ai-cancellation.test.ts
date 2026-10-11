import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  MOCK_AI_CANCELLATION_REPLY_TAIL,
  mockAiCancellationChunks,
  mockAiCancellationSignal,
} from "./mock-ai-cancellation";

const readReplyTail = async (
  chunks: ReturnType<typeof mockAiCancellationChunks>,
) => {
  let tail = "";
  while (tail !== MOCK_AI_CANCELLATION_REPLY_TAIL) {
    const chunk = await chunks.next();
    expect(chunk.done).toBe(false);
    tail += chunk.value;
  }
};

test("the cancellation fixture stays live until its provider run is stopped", async () => {
  const run = new AbortController();
  const chunks = mockAiCancellationChunks(run.signal);
  expect(await chunks.next()).toEqual({
    done: false,
    value: "This mock reply streams back",
  });
  await readReplyTail(chunks);
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

test("both SDK signal fields cancel the same fixture", async () => {
  for (const shape of ["request-init", "request", "abort-signal"] as const) {
    const run = new AbortController();
    const options =
      shape === "abort-signal"
        ? { abortSignal: run.signal }
        : {
            request:
              shape === "request"
                ? new Request("https://example.test", { signal: run.signal })
                : { signal: run.signal },
          };
    const signal = mockAiCancellationSignal(options);
    expect(signal?.aborted).toBe(false);
    const chunks = mockAiCancellationChunks(signal);
    expect((await chunks.next()).done).toBe(false);
    await readReplyTail(chunks);
    const pending = chunks.next();
    const reason = new DOMException("Stopped", "AbortError");
    run.abort(reason);
    expect(await rejectionOf(pending)).toBe(reason);
  }
});

test("the SDK abortSignal takes precedence over a request signal", () => {
  const run = new AbortController();
  const request = new AbortController();
  expect(
    mockAiCancellationSignal({
      abortSignal: run.signal,
      request: { signal: request.signal },
    }),
  ).toBe(run.signal);
  expect(
    mockAiCancellationSignal({ request: { signal: null } }),
  ).toBeUndefined();
  expect(mockAiCancellationSignal({})).toBeUndefined();
});
