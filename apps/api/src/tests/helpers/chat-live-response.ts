import { panic } from "better-result";

// A chat response relayed to the page while the server is still writing it,
// the way a socket carries it: the page reads what the server has written so
// far, and closing the connection from either end reaches the other. The
// harness records what the page read and how the response ended.

/** How a relayed response ended: read to its end, or cut off first (the
 *  page stopped, the connection dropped, or the server's stream failed). */
export type LiveResponseEnding = "complete" | "disconnected";

export type LiveResponse = {
  /** The response body the page reads. */
  body: ReadableStream<Uint8Array>;
  /** Closes the connection: the server's response is cancelled and the
   *  page's read fails with `error`. A no-op once the response has ended. */
  disconnect: (error: Error) => void;
  /** Settles once the response has ended, with what the page read. */
  ended: Promise<{ ending: LiveResponseEnding; text: string }>;
};

export const relayLiveResponse = (
  served: ReadableStream<Uint8Array>,
): LiveResponse => {
  const decoder = new TextDecoder();
  const ended = Promise.withResolvers<{
    ending: LiveResponseEnding;
    text: string;
  }>();
  const connection = Promise.withResolvers<Error>();
  let text = "";
  let open = true;
  let page: ReadableStreamDefaultController<Uint8Array> | undefined;

  /** Ends the page's side once, with an error or at the end of the body. */
  const finish = (ending: LiveResponseEnding, error?: unknown) => {
    if (!open) {
      return;
    }
    open = false;
    if (error === undefined) {
      page?.close();
    } else {
      page?.error(error);
    }
    ended.resolve({ ending, text });
  };
  const disconnect = (error: Error) => {
    if (!open) {
      return;
    }
    connection.resolve(error);
  };

  const relay = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) => {
    const reader = served.getReader();
    try {
      while (true) {
        const next = await Promise.race([reader.read(), connection.promise]);
        if (next instanceof Error) {
          // A closed connection cancels the server's response, as a closed
          // socket does.
          await reader.cancel(next).catch(() => undefined);
          finish("disconnected", next);
          return;
        }
        if (next.done) {
          finish("complete");
          return;
        }
        const chunk: unknown = next.value;
        if (!(chunk instanceof Uint8Array)) {
          panic("The server wrote a chunk that is not bytes");
        }
        text += decoder.decode(chunk, { stream: true });
        controller.enqueue(chunk);
      }
    } catch (error) {
      // The server's stream failed: the page's read fails the same way.
      await reader.cancel(error).catch(() => undefined);
      finish("disconnected", error);
    } finally {
      // Every exit cancels: after the end of the response, or once cancelled
      // already, this is a no-op.
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  };

  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      page = controller;
      // `relay` settles every path itself, so nothing waits on it.
      void relay(controller);
    },
    cancel: (reason) => {
      disconnect(reason instanceof Error ? reason : new Error("Cancelled"));
    },
  });

  return { body, disconnect, ended: ended.promise };
};
