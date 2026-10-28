import { panic, Result } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

import type { Fetcher, FetchWithTimeoutInit } from "@stll/fetch";

import type { Transaction } from "@/api/db/root";
import type { AnyDrizzle } from "@/api/db/scoped";
import { detached } from "@/api/lib/analytics/capture";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { fetchPublicReadRequest } from "@/api/lib/safe-outbound-fetch";

import type {
  PublicReadIoMethods,
  PublicReadTransport,
} from "./public-read-transports";

type PublicReadWork = {
  pending: Set<Promise<void>>;
  status: "active" | "settling" | "settled";
};
type PublicReadContext = {
  budgetMs: number;
  signal?: AbortSignal | undefined;
  work?: PublicReadWork | undefined;
};

const publicReadTimeout = new AsyncLocalStorage<PublicReadContext>();

const combinedPublicReadSignal = (...signals: (AbortSignal | undefined)[]) => {
  const active = signals.filter(
    (candidate): candidate is AbortSignal => candidate !== undefined,
  );
  return active.length === 0 ? undefined : AbortSignal.any(active);
};

export const getPublicReadStatementTimeoutMs = () =>
  publicReadTimeout.getStore()?.budgetMs;
export const getPublicReadSignal = () => publicReadTimeout.getStore()?.signal;

type PublicReadTimeoutOptions = {
  budgetMs: number;
  signal?: AbortSignal | undefined;
};

export const runWithPublicReadStatementTimeout = <T>(
  { budgetMs, signal = getPublicReadSignal() }: PublicReadTimeoutOptions,
  fn: () => T,
): T =>
  publicReadTimeout.run(
    {
      budgetMs,
      signal: combinedPublicReadSignal(signal, getPublicReadSignal()),
      work: publicReadTimeout.getStore()?.work,
    },
    fn,
  );

/** Keep every transport alive through cancellation and resource cleanup. */
export const runWithPublicReadScope = async <T>(
  { budgetMs, signal }: PublicReadTimeoutOptions,
  fn: () => Promise<T>,
): Promise<T> => {
  const inherited = publicReadTimeout.getStore();
  const scopeSignal = combinedPublicReadSignal(signal, inherited?.signal);
  const work: PublicReadWork = { pending: new Set(), status: "active" };
  return await trackPublicRead(
    inherited?.work,
    async () =>
      await publicReadTimeout.run(
        { budgetMs, signal: scopeSignal, work },
        async () => {
          const outcome = await Result.tryPromise({
            try: fn,
            catch: (error: unknown) => error,
          });
          work.status = "settling";
          while (work.pending.size > 0) {
            await Promise.allSettled(work.pending);
          }
          work.status = "settled";
          scopeSignal?.throwIfAborted();
          if (Result.isError(outcome)) {
            const error = outcome.error;
            throw error;
          }
          return outcome.value;
        },
      ),
  );
};

const registerPublicRead = (work: PublicReadWork | undefined) => {
  if (work === undefined) {
    return () => undefined;
  }
  if (work.status === "settled") {
    return panic("Public read started after its admission scope settled");
  }
  const completed = Promise.withResolvers<undefined>();
  work.pending.add(completed.promise);
  return () => {
    work.pending.delete(completed.promise);
    completed.resolve(undefined);
  };
};

const trackPublicRead = async <T>(
  work: PublicReadWork | undefined,
  operation: () => Promise<T>,
): Promise<T> => {
  const finish = registerPublicRead(work);
  try {
    return await operation();
  } finally {
    finish();
  }
};

const PUBLIC_READ_IO = Symbol("PublicReadIo");
export type PublicReadIo = {
  readonly [PUBLIC_READ_IO]: true;
  readonly transport: PublicReadTransport;
  readonly signal: AbortSignal | undefined;
} & PublicReadIoMethods<AnyDrizzle<Transaction>, Transaction>;

type OwnedResponseOptions = {
  response: Response;
  signal: AbortSignal | undefined;
  finish: () => void;
};

const ownedResponse = ({
  response,
  signal,
  finish,
}: OwnedResponseOptions): Response => {
  if (response.body === null) {
    finish();
    return response;
  }
  const reader = response.body.getReader();
  let state:
    | { status: "active" }
    | { status: "cancelling"; completion: Promise<void> }
    | { status: "settled" } = { status: "active" };
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const settle = () => {
    if (state.status === "settled") {
      return;
    }
    state = { status: "settled" };
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
    finish();
  };
  const cancel = async (reason: unknown) => {
    switch (state.status) {
      case "settled":
        return;
      case "cancelling":
        await state.completion;
        return;
      case "active":
        break;
      default:
        state satisfies never;
        panic("Unhandled public response state");
    }
    const completion = Promise.withResolvers<undefined>();
    state = { status: "cancelling", completion: completion.promise };
    const cancelled = await Result.tryPromise({
      try: async () => await reader.cancel(reason),
      catch: (error: unknown) => error,
    });
    if (Result.isError(cancelled) && !signal?.aborted) {
      controller?.error(cancelled.error);
    }
    settle();
    completion.resolve(undefined);
  };
  const abort = () => {
    controller?.error(signal?.reason);
    // The registered operation remains pending until actual stream cancellation settles.
    detached(cancel(signal?.reason), "public-read.cancel-body");
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start: (streamController) => {
        controller = streamController;
      },
      pull: async (streamController) => {
        const next = await Result.tryPromise({
          try: async () => await reader.read(),
          catch: (error: unknown) => error,
        });
        if (state.status !== "active") {
          return;
        }
        if (Result.isError(next)) {
          streamController.error(next.error);
          await cancel(next.error);
          return;
        }
        if (next.value.done) {
          streamController.close();
          settle();
          return;
        }
        const chunk: unknown = next.value.value;
        if (!(chunk instanceof Uint8Array)) {
          panic("Public HTTP response contained a non-byte chunk");
        }
        streamController.enqueue(chunk);
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    abort();
  }
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(wrapped, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  });
  return wrapped;
};

type PublicReadFetchOptions = {
  capability: PublicReadIo;
  context: PublicReadContext | undefined;
  input: string | URL | Request;
  init: FetchWithTimeoutInit;
  fetcher?: Fetcher | undefined;
};

const fetchPublicRead = async ({
  capability,
  context,
  input,
  init,
  fetcher,
}: PublicReadFetchOptions): Promise<Response> => {
  const finish = registerPublicRead(context?.work);
  const signal = combinedPublicReadSignal(
    context?.signal,
    init.signal,
    input instanceof Request ? input.signal : undefined,
  );
  const result = await Result.tryPromise({
    try: async () =>
      await fetchPublicReadRequest({
        capability,
        input,
        init: { ...init, signal },
        fetcher,
      }),
    catch: (error: unknown) => error,
  });
  if (Result.isError(result)) {
    finish();
    const error = result.error;
    throw error;
  }
  return context?.work === undefined
    ? result.value
    : ownedResponse({ response: result.value, signal, finish });
};

/** Capabilities capture their scope and cannot open I/O after it settles. */
export const withPublicReadIo = async <T>(
  transport: PublicReadTransport,
  run: (io: PublicReadIo) => Promise<T>,
): Promise<T> => {
  const context = publicReadTimeout.getStore();
  return await trackPublicRead(context?.work, async () => {
    context?.signal?.throwIfAborted();
    const io: PublicReadIo = {
      [PUBLIC_READ_IO]: true,
      transport,
      signal: context?.signal,
      readTransaction: async (database, operation) =>
        await trackPublicRead(context?.work, async () => {
          context?.signal?.throwIfAborted();
          return await withAggregateTransaction(database, operation);
        }),
      fetchStream: async (input, init, fetcher) =>
        await fetchPublicRead({
          capability: io,
          context,
          input,
          init,
          fetcher,
        }),
      fetch: async (input, init, consume, fetcher) => {
        const response = await fetchPublicRead({
          capability: io,
          context,
          input,
          init,
          fetcher,
        });
        const outcome = await Result.tryPromise({
          try: async () => await consume(response),
          catch: (error: unknown) => error,
        });
        const body = response.body;
        const cleanup =
          body !== null && !body.locked
            ? await Result.tryPromise({
                try: async () => await body.cancel(),
                catch: (error: unknown) => error,
              })
            : Result.ok(undefined);
        if (Result.isError(outcome)) {
          const error = outcome.error;
          throw error;
        }
        if (Result.isError(cleanup)) {
          const error = cleanup.error;
          throw error;
        }
        return outcome.value;
      },
    };
    return await run(io);
  });
};
