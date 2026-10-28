import {
  InfiniteQueryObserver,
  infiniteQueryOptions,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
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

const createPagedNotificationsHarness = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const requests: {
    pageParam: number;
    request: ReturnType<typeof deferred<string>>;
  }[] = [];
  const options = infiniteQueryOptions({
    queryKey: ["notifications", "organization-1", "user-1", "list"],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const request = deferred<string>();
      requests.push({ pageParam, request });
      return await request.promise;
    },
    getNextPageParam: (_lastPage, pages) => pages.length,
  });
  client.setQueryData(options.queryKey, {
    pages: [
      "notification page 1",
      "notification page 2",
      "notification page 3",
    ],
    pageParams: [0, 1, 2],
  });
  const observer = new InfiniteQueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => undefined);
  const prepare = () => {
    client.setQueryData(options.queryKey, (cached) =>
      cached === undefined
        ? cached
        : {
            pages: cached.pages.slice(0, 1),
            pageParams: cached.pageParams.slice(0, 1),
          },
    );
  };
  return {
    client,
    close: () => {
      unsubscribe();
      client.clear();
    },
    observer,
    options,
    prepare,
    requests,
    scheduler: createRealtimeRefreshScheduler(client),
  };
};

test("an in-flight notification page settles before trimming and refreshing only the first page", async () => {
  const harness = createPagedNotificationsHarness();
  const nextPage = harness.observer.fetchNextPage();
  expect(harness.requests.map(({ pageParam }) => pageParam)).toEqual([3]);

  harness.scheduler.refresh(harness.options.queryKey, harness.prepare);
  expect(
    harness.client.getQueryData(harness.options.queryKey)?.pages,
  ).toHaveLength(3);

  harness.requests[0]?.request.resolve("notification page 4");
  await nextPage;
  await settle();
  expect(harness.requests.map(({ pageParam }) => pageParam)).toEqual([3, 0]);
  harness.requests[1]?.request.resolve("refreshed notification page 1");
  await settle();

  expect(harness.client.getQueryData(harness.options.queryKey)).toEqual({
    pages: ["refreshed notification page 1"],
    pageParams: [0],
  });
  harness.close();
});

test("an idle notification query trims and refreshes its first page once", async () => {
  const harness = createPagedNotificationsHarness();
  harness.scheduler.refresh(harness.options.queryKey, harness.prepare);

  expect(harness.requests.map(({ pageParam }) => pageParam)).toEqual([0]);
  expect(
    harness.client.getQueryData(harness.options.queryKey)?.pages,
  ).toHaveLength(1);
  harness.requests[0]?.request.resolve("refreshed notification page 1");
  await settle();

  expect(harness.requests).toHaveLength(1);
  expect(harness.client.getQueryData(harness.options.queryKey)).toEqual({
    pages: ["refreshed notification page 1"],
    pageParams: [0],
  });
  harness.close();
});
