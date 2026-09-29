import type { StreamChunk, StreamDurability } from "@tanstack/ai";
import { Result, TaggedError } from "better-result";

import { detached } from "@/api/lib/analytics/capture";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { emitChatRunLogMetric } from "@/api/lib/observability/request-metrics";

const MAX_PENDING_BYTES = 256 * 1024;
const MAX_PENDING_CHUNKS = 256;
const MAX_TURN_BYTES = 32 * 1024 * 1024;
const DRAIN_BUDGET_MS = 100;
const SHADOW_FAILED_SINK = failureSink({
  event: "chat.run.shadow_failed",
  expected: [],
});

class ChatRunShadowError extends TaggedError("ChatRunShadowError")<{
  message: string;
}> {}

type ChatRunShadowOptions = {
  enabled: boolean;
  createLog: () => Pick<StreamDurability, "append">;
  source: AsyncIterable<StreamChunk>;
  observe?: (error: unknown) => void;
  measure?: typeof emitChatRunLogMetric;
};

/** A bounded, best-effort prefix; client delivery never waits for an append. */
export const shadowChatRun = ({
  enabled,
  createLog,
  source,
  observe = (error) => observeFailure(error, { sink: SHADOW_FAILED_SINK }),
  measure = emitChatRunLogMetric,
}: ChatRunShadowOptions) => {
  if (!enabled) {
    return { source, flush: async () => undefined };
  }
  const created = Result.try(createLog);
  if (Result.isError(created)) {
    observe(created.error);
    return { source, flush: async () => undefined };
  }
  const log = created.value;
  let pending: StreamChunk[] = [];
  let pendingBytes = 0;
  let acceptedBytes = 0;
  let rows = 0;
  let bytes = 0;
  let stopped = false;
  let worker: Promise<void> | undefined;
  const stop = (error: unknown) => {
    stopped = true;
    observe(error);
    pending = [];
    pendingBytes = 0;
  };
  const record = (metric: Parameters<typeof emitChatRunLogMetric>[0]) => {
    const measured = Result.try(() => measure(metric));
    if (Result.isError(measured)) {
      stop(measured.error);
    }
  };
  const appendPending = async () => {
    while (pending.length > 0) {
      if (stopped) {
        return;
      }
      const batch = pending;
      const batchBytes = pendingBytes;
      pending = [];
      pendingBytes = 0;
      const start = performance.now();
      const result = await Result.tryPromise(() => log.append(batch));
      record({ type: "append", durationMs: performance.now() - start });
      if (Result.isError(result)) {
        stop(result.error);
        return;
      }
      rows += batch.length;
      bytes += batchBytes;
    }
  };
  const startWorker = (): void => {
    worker ??= Promise.resolve()
      .then(appendPending)
      .finally(() => {
        worker = undefined;
        if (!stopped && pending.length > 0) {
          startWorker();
        }
      });
  };
  const enqueue = (chunk: StreamChunk) => {
    if (stopped) {
      return;
    }
    const size = new TextEncoder().encode(JSON.stringify(chunk)).byteLength;
    if (
      pending.length >= MAX_PENDING_CHUNKS ||
      pendingBytes + size > MAX_PENDING_BYTES ||
      acceptedBytes + size > MAX_TURN_BYTES
    ) {
      stop(
        new ChatRunShadowError({ message: "Chat shadow log budget exceeded" }),
      );
      return;
    }
    pending.push(structuredClone(chunk));
    pendingBytes += size;
    acceptedBytes += size;
    startWorker();
  };
  return {
    source: (async function* () {
      for await (const chunk of source) {
        const queued = Result.try(() => enqueue(chunk));
        if (Result.isError(queued)) {
          stop(queued.error);
        }
        yield chunk;
      }
    })(),
    flush: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        (async () => {
          for (;;) {
            const current = worker;
            if (current === undefined) {
              return;
            }
            await current;
          }
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            if (!stopped) {
              stop(
                new ChatRunShadowError({
                  message: "Chat shadow log drain timed out",
                }),
              );
            }
            resolve();
          }, DRAIN_BUDGET_MS);
        }),
      ]);
      clearTimeout(timer);
      // Settlement removes the fence: no new append may start beyond here.
      stopped = true;
      pending = [];
      pendingBytes = 0;
      // A transaction already in flight can commit after the drain deadline.
      // Report its actual rows too, without making settlement wait for it.
      detached(
        Promise.resolve(worker).then(() => {
          record({ type: "turn", rows, bytes });
          return undefined;
        }),
        "chat-run-shadow.metrics",
      );
    },
  };
};
