// The one module that constructs a TanStack `StreamProcessor`.
//
// A processor folds a run's chunks into the message the run produced. A chat
// turn's persisted message is built from one in `processTurnForPersistence`;
// a second construction with its own event wiring could accumulate something
// other than what production stores, so every accumulation starts here and
// callers only choose what to keep from the finished message.

import { StreamProcessor } from "@tanstack/ai";
import type { UIMessage } from "@tanstack/ai";

export type ChatStreamProcessor = StreamProcessor;

export type StreamMessageCapture<TMessage> = {
  readonly processor: ChatStreamProcessor;
  /**
   * What `capture` returned for the finished message, or `null` while the
   * stream is still open.
   */
  readonly message: () => TMessage | null;
};

type CreateStreamMessageCaptureOptions<TMessage> = {
  /** The history the run starts from: the messages it may continue. */
  initialMessages: UIMessage[];
  /** Runs once, when the stream ends, on the message it produced. */
  capture: (message: UIMessage) => TMessage | null;
};

export const createStreamMessageCapture = <TMessage>({
  initialMessages,
  capture,
}: CreateStreamMessageCaptureOptions<TMessage>): StreamMessageCapture<TMessage> => {
  // Captured on an object property, not a bare `let`: `onStreamEnd` runs
  // later, and type-aware lint narrows a closure-mutated local to its
  // initializer.
  const captured: { message: TMessage | null } = { message: null };
  const processor = new StreamProcessor({
    initialMessages,
    events: {
      onStreamEnd: (message) => {
        captured.message = capture(message);
      },
    },
  });
  return { processor, message: () => captured.message };
};
