import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { QueryFunctionContext } from "@tanstack/react-query";
import { expect, test } from "bun:test";

import { createRealtimeRefreshScheduler } from "@/lib/realtime-refresh";

const QUERY_KEY = ["realtime-refresh-test"] as const;

const deferred = <T>() => {
  let resolveDeferred!: (value: T) => void;
  let rejectDeferred!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return {
    promise,
    reject: rejectDeferred,
    resolve: resolveDeferred,
  };
};

const settle = async () => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

const createHarness = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const requests: ReturnType<typeof deferred<number>>[] = [];
  let aborts = 0;
  // The query function records requests and aborts for the assertions; the
  // records are instrumentation, not part of the query's identity.
  const queryFn = async ({ signal }: QueryFunctionContext) => {
    const request = deferred<number>();
    requests.push(request);
    signal.addEventListener("abort", () => {
      aborts += 1;
    });
    return await request.promise;
  };
  const observer = new QueryObserver(client, { queryKey: QUERY_KEY, queryFn });
  const unsubscribe = observer.subscribe(() => undefined);
  return {
    client,
    requests,
    scheduler: createRealtimeRefreshScheduler(client),
    aborts: () => aborts,
    close: () => {
      unsubscribe();
      client.clear();
    },
  };
};

test("fifty realtime events queue one refresh without aborting the tree fetch", async () => {
  const harness = createHarness();
  expect(harness.requests).toHaveLength(1);
  for (let index = 0; index < 50; index += 1) {
    harness.scheduler.refresh(QUERY_KEY);
  }
  expect(harness.requests).toHaveLength(1);
  expect(harness.aborts()).toBe(0);

  harness.requests[0]?.resolve(1);
  await settle();
  expect(harness.requests).toHaveLength(2);
  harness.requests[1]?.resolve(2);
  await settle();

  expect(harness.requests).toHaveLength(2);
  expect(harness.aborts()).toBe(0);
  harness.close();
});

test("an event during the trailing fetch queues one more refresh", async () => {
  const harness = createHarness();
  harness.scheduler.refresh(QUERY_KEY);
  harness.requests[0]?.resolve(1);
  await settle();
  expect(harness.requests).toHaveLength(2);

  harness.scheduler.refresh(QUERY_KEY);
  harness.requests[1]?.resolve(2);
  await settle();
  expect(harness.requests).toHaveLength(3);
  harness.requests[2]?.resolve(3);
  await settle();
  expect(harness.aborts()).toBe(0);
  harness.close();
});

test("a failed fetch still releases its queued refresh", async () => {
  const harness = createHarness();
  harness.scheduler.refresh(QUERY_KEY);
  harness.requests[0]?.reject(new Error("fixture failure"));
  await settle();
  expect(harness.requests).toHaveLength(2);
  harness.requests[1]?.resolve(2);
  await settle();
  expect(harness.aborts()).toBe(0);
  harness.close();
});

test("an idle query refreshes immediately once", async () => {
  const harness = createHarness();
  harness.requests[0]?.resolve(1);
  await settle();
  harness.scheduler.refresh(QUERY_KEY);
  expect(harness.requests).toHaveLength(2);
  harness.requests[1]?.resolve(2);
  await settle();
  expect(harness.requests).toHaveLength(2);
  harness.close();
});
