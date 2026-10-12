import { Result, TaggedError } from "better-result";
import { once } from "node:events";
import type { Writable } from "node:stream";

const POST_EXIT_DRAIN_MS = 1000;

class TestStderrError extends TaggedError("TestStderrError")<{
  message: string;
  cause?: unknown;
}> {}

type ForwardTestStderrOptions = {
  child: Pick<
    Bun.Subprocess<"ignore", "ignore", "pipe">,
    "pid" | "stderr" | "exited"
  >;
  destination: Writable;
  onChunk: (chunk: Uint8Array) => void;
  onWarning: (message: string) => void;
  postExitDrainMs?: number;
};

export const forwardTestStderr = async ({
  child,
  destination,
  onChunk,
  onWarning,
  postExitDrainMs = POST_EXIT_DRAIN_MS,
}: ForwardTestStderrOptions) => {
  const reader = child.stderr.getReader();
  const cancellation = new AbortController();
  let timeoutError: TestStderrError | undefined;
  const cancelReader = () =>
    Result.tryPromise({
      try: async () => {
        await reader.cancel();
      },
      catch: (cause) =>
        new TestStderrError({
          message: `Could not cancel stderr for PID ${child.pid}`,
          cause,
        }),
    });
  let readerCancellation: ReturnType<typeof cancelReader> | undefined;
  const drained = Result.tryPromise({
    try: async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        onChunk(value);
        if (!destination.write(value)) {
          await once(destination, "drain", { signal: cancellation.signal });
        }
      }
    },
    catch: (cause) =>
      new TestStderrError({
        message: `Could not forward stderr for PID ${child.pid}`,
        cause,
      }),
  });
  const exitDrained = child.exited.then(async () => {
    const timer = setTimeout(() => {
      timeoutError = new TestStderrError({
        message: `Test stderr remained open ${postExitDrainMs}ms after PID ${child.pid} exited`,
      });
      cancellation.abort();
      readerCancellation = cancelReader();
    }, postExitDrainMs);
    try {
      return await drained;
    } finally {
      clearTimeout(timer);
    }
  });
  try {
    const first = await Promise.race([drained, exitDrained]);
    const outcome = first.isErr() ? first : await exitDrained;
    return timeoutError === undefined ? outcome : Result.err(timeoutError);
  } finally {
    cancellation.abort();
    const cancelled = await (readerCancellation ?? cancelReader());
    if (cancelled.isErr()) {
      onWarning(cancelled.error.message);
    }
    reader.releaseLock();
  }
};
