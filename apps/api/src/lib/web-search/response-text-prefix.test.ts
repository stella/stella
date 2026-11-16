import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";
import { deferred } from "@stll/test-kit";

import { readResponseTextPrefix } from "@/api/lib/web-search/response-text-prefix";
import { HAPPY_PATH_TIMEOUT_MS } from "@/api/tests/test-timeouts";

const responseFromChunks = (chunks: readonly Uint8Array[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
  );

describe("bounded provider text prefixes", () => {
  test("provider-text-prefix: chunking preserves Response.text UTF-16 slice semantics", async () => {
    await assertProperty(
      "provider-text-prefix: chunking preserves Response.text UTF-16 slice semantics",
      fc.asyncProperty(
        fc.array(fc.uint8Array({ maxLength: 64 }), { maxLength: 8 }),
        fc.nat(80),
        async (chunks, maxChars) => {
          const bytes = new Uint8Array(
            chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
          );
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const whole = await new Response(bytes).text();
          expect(
            await readResponseTextPrefix(responseFromChunks(chunks), {
              maxChars,
              idleMs: HAPPY_PATH_TIMEOUT_MS,
              signal: new AbortController().signal,
            }),
          ).toEqual({
            content: whole.slice(0, maxChars),
            truncated: whole.length > maxChars,
          });
        },
      ),
    );
  });

  test.each(["", "abc", "\uFEFFŽluťoučký", "A😀B", "a\u0301", "\uFFFD"])(
    "single-byte chunks preserve every UTF-16 boundary in %s",
    async (text) => {
      const bytes = new TextEncoder().encode(text);
      const whole = await new Response(bytes).text();
      const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
      for (let maxChars = 0; maxChars <= whole.length + 1; maxChars++) {
        expect(
          await readResponseTextPrefix(responseFromChunks(chunks), {
            maxChars,
            idleMs: HAPPY_PATH_TIMEOUT_MS,
            signal: new AbortController().signal,
          }),
        ).toEqual({
          content: whole.slice(0, maxChars),
          truncated: whole.length > maxChars,
        });
      }
    },
  );

  test("flushes an incomplete UTF-8 tail before deciding exact fit", async () => {
    const bytes = new Uint8Array([65, 0xf0, 0x9f]);
    const whole = await new Response(bytes).text();
    expect(whole).toBe("A\uFFFD");
    for (const maxChars of [1, 2, 3]) {
      expect(
        await readResponseTextPrefix(responseFromChunks([bytes]), {
          maxChars,
          idleMs: HAPPY_PATH_TIMEOUT_MS,
          signal: new AbortController().signal,
        }),
      ).toEqual({
        content: whole.slice(0, maxChars),
        truncated: whole.length > maxChars,
      });
    }
  });

  test("cancels an unfinished large chunk after the lookahead character", async () => {
    const cancelled = deferred<undefined>();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("a".repeat(64 * 1024)));
        },
        cancel() {
          cancelled.resolve(undefined);
        },
      }),
    );
    expect(
      await readResponseTextPrefix(response, {
        maxChars: 1,
        idleMs: HAPPY_PATH_TIMEOUT_MS,
        signal: new AbortController().signal,
      }),
    ).toEqual({ content: "a", truncated: true });
    await cancelled.promise;
  });

  test("caller cancellation preserves its reason while waiting for lookahead", async () => {
    const reached = deferred<undefined>();
    const cancelled = deferred<unknown>();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          reached.resolve(undefined);
        },
        cancel(reason) {
          cancelled.resolve(reason);
        },
      }),
    );
    const caller = new AbortController();
    const reason = new DOMException("Provider read cancelled", "AbortError");
    const failure = rejectionOf(
      readResponseTextPrefix(response, {
        maxChars: 1,
        idleMs: HAPPY_PATH_TIMEOUT_MS,
        signal: caller.signal,
      }),
    );
    await reached.promise;
    caller.abort(reason);
    expect(await failure).toBe(reason);
    expect(await cancelled.promise).toBe(reason);
  });

  test("a body failure remains a failure before the prefix is complete", async () => {
    const reason = new DOMException("Provider body failed", "NetworkError");
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(reason);
        },
      }),
    );
    expect(
      await rejectionOf(
        readResponseTextPrefix(response, {
          maxChars: 1,
          idleMs: HAPPY_PATH_TIMEOUT_MS,
          signal: new AbortController().signal,
        }),
      ),
    ).toBe(reason);
  });
});
