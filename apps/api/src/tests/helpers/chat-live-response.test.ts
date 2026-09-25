import { describe, expect, test } from "bun:test";

import { relayLiveResponse } from "@/api/tests/helpers/chat-live-response";

const encoder = new TextEncoder();

/** A server response that writes `events`, then does what `end` says. */
const served = (
  events: readonly string[],
  end: "close" | "fail" | "stay-open",
) => {
  let cancelled: unknown;
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      if (end === "close") {
        controller.close();
      }
      if (end === "fail") {
        controller.error(new Error("The server's stream failed"));
      }
    },
    cancel: (reason) => {
      cancelled = reason;
    },
  });
  return { cancelled: () => cancelled, stream };
};

/** Reads the page's body to its end; rejects with the error it fails with. */
const readPage = async (body: ReadableStream<Uint8Array>) =>
  await new Response(body).text();

describe("a chat response relayed to the page", () => {
  test("ends complete once the server ends it", async () => {
    const server = served(["data: 1\n\n", "data: 2\n\n"], "close");
    const live = relayLiveResponse(server.stream);

    expect(await readPage(live.body)).toBe("data: 1\n\ndata: 2\n\n");
    expect(await live.ended).toEqual({
      ending: "complete",
      text: "data: 1\n\ndata: 2\n\n",
    });
  });

  test("cancels the server's response when the connection closes", async () => {
    const server = served(["data: 1\n\n"], "stay-open");
    const live = relayLiveResponse(server.stream);
    const dropped = new TypeError("The connection dropped");

    const read = readPage(live.body);
    // The page has what the server wrote before the connection closes.
    await Bun.sleep(0);
    live.disconnect(dropped);

    expect(await live.ended).toEqual({
      ending: "disconnected",
      text: "data: 1\n\n",
    });
    expect(server.cancelled()).toBe(dropped);
    expect(await read.catch((error: unknown) => error)).toBe(dropped);
  });

  test("settles, and fails the page's read, when the server's stream fails", async () => {
    const server = served(["data: 1\n\n"], "fail");
    const live = relayLiveResponse(server.stream);

    const read = readPage(live.body);

    expect((await live.ended).ending).toBe("disconnected");
    const failure = await read.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("The server's stream failed");
  });
});
