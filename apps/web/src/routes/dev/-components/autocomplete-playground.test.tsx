import { expect, test } from "bun:test";

import { consumeStream } from "./autocomplete-stream";

const flush = async () => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

test("a terminal autocomplete frame settles and cancels an open body", async () => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  let settled = false;
  const result = consumeStream(response, new AbortController().signal, {
    onToken() {},
    onStreamError() {},
  }).then(() => {
    settled = true;
    return undefined;
  });

  stream?.enqueue(new TextEncoder().encode("event: done\ndata: {}\n\n"));
  await flush();

  expect(settled).toBe(true);
  expect(cancelled).toBe(true);
  await result;
});
