import {
  InfiniteQueryObserver,
  infiniteQueryOptions,
  QueryClient,
  QueryObserver,
  queryOptions,
} from "@tanstack/react-query";
import type { QueryFunctionContext } from "@tanstack/react-query";
import { describe, expect, mock, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import {
  CriticalQueryTimeoutError,
  ensureCriticalQueryData,
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
  fetchRouteQuery,
  prefetchNonCriticalInfiniteQuery,
  prefetchNonCriticalQuery,
  ROUTE_QUERY_STALE_TIME_MS,
  routeQueryOptions,
} from "@/lib/react-query";

describe("ensureCriticalQueryData", () => {
  test("cancels timed-out critical queries and reports the query key", async () => {
    const queryClient = new QueryClient();
    const queryKey = ["workspaces", "ws_1"] as const;
    let abortReceived = false;
    let fetchStarted = false;

    const result = ensureCriticalQueryData(
      queryClient,
      {
        queryKey,
        queryFn: async ({ signal }) => {
          fetchStarted = true;
          return await new Promise<string>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                abortReceived = true;
                reject(new Error("Query aborted", { cause: signal.reason }));
              },
              { once: true },
            );
          });
        },
      },
      { timeoutMs: 1 },
    );

    let caughtError: unknown;
    try {
      await result;
    } catch (error) {
      caughtError = error;
    }

    expect(fetchStarted).toBe(true);
    expect(CriticalQueryTimeoutError.is(caughtError)).toBe(true);
    if (!CriticalQueryTimeoutError.is(caughtError)) {
      throw new Error("Expected CriticalQueryTimeoutError");
    }

    expect(caughtError.queryKey).toEqual(queryKey);
    expect(caughtError.message).toContain(JSON.stringify(queryKey));

    await sleep(0);

    expect(abortReceived).toBe(true);
    expect(queryClient.getQueryCache().find({ queryKey })?.state).toMatchObject(
      {
        fetchStatus: "idle",
        status: "error",
      },
    );
  });

  test("does not cancel queries that resolve before the timeout", async () => {
    const queryClient = new QueryClient();
    const queryKey = ["workspaces", "ws_2"] as const;
    let abortReceived = false;

    const result = await ensureCriticalQueryData(
      queryClient,
      {
        queryKey,
        queryFn: async ({ signal }) => {
          signal.addEventListener("abort", () => {
            abortReceived = true;
          });
          return "ok";
        },
      },
      { timeoutMs: 1 },
    );

    await sleep(5);

    expect(result).toBe("ok");
    expect(abortReceived).toBe(false);
    expect(queryClient.getQueryData<string>(queryKey)).toBe("ok");
  });
});

describe("routeQueryOptions", () => {
  test("adds the route freshness window by default", () => {
    const options = routeQueryOptions({
      queryKey: ["route-query"],
      queryFn: async () => "ok",
    });

    expect(options.staleTime).toBe(ROUTE_QUERY_STALE_TIME_MS);
  });

  test("preserves every explicit stale time policy", () => {
    for (const staleTime of [
      0,
      1000,
      Number.POSITIVE_INFINITY,
      "static",
      () => Number.POSITIVE_INFINITY,
    ]) {
      const options = routeQueryOptions({
        queryKey: ["route-query", "explicit"],
        queryFn: async () => "ok",
        staleTime,
      });

      expect(options.staleTime).toBe(staleTime);
    }
  });
});

describe("ensureRouteInfiniteQueryData", () => {
  test("fetches when cached infinite data is stale", async () => {
    const queryClient = new QueryClient();
    const queryKey = ["route-infinite-query"] as const;

    queryClient.setQueryData(queryKey, {
      pageParams: [0],
      pages: ["stale"],
    });

    const data = await ensureRouteInfiniteQueryData(queryClient, {
      getNextPageParam: () => undefined,
      initialPageParam: 0,
      queryFn: async () => "fresh",
      queryKey,
      staleTime: 0,
    });

    expect(data.pages).toEqual(["fresh"]);
  });
});

describe("prefetchNonCriticalQuery", () => {
  test("reports errors through onError", async () => {
    const queryClient = new QueryClient();
    const expectedError = new Error("boom");
    const onError = mock((_error: unknown): void => {});

    await prefetchNonCriticalQuery(
      queryClient,
      {
        queryKey: ["failing-query"],
        queryFn: async () => {
          throw expectedError;
        },
      },
      onError,
    );

    expect(onError).toHaveBeenCalledWith(expectedError);
  });

  test("does not report successful prefetches", async () => {
    const queryClient = new QueryClient();
    const onError = mock((_error: unknown): void => {});

    await prefetchNonCriticalQuery(
      queryClient,
      {
        queryKey: ["successful-query"],
        queryFn: async () => "ok",
      },
      onError,
    );

    expect(onError).not.toHaveBeenCalled();
  });
});

describe("prefetchNonCriticalInfiniteQuery", () => {
  test("reports every independently failing prefetch", async () => {
    const queryClient = new QueryClient();
    const firstError = new Error("first failure");
    const secondError = new Error("second failure");
    const onError = mock((_error: unknown): void => {});

    await Promise.all([
      prefetchNonCriticalInfiniteQuery(
        queryClient,
        {
          getNextPageParam: () => undefined,
          initialPageParam: 0,
          queryKey: ["first-failing-infinite-query"],
          queryFn: async () => {
            throw firstError;
          },
        },
        onError,
      ),
      prefetchNonCriticalInfiniteQuery(
        queryClient,
        {
          getNextPageParam: () => undefined,
          initialPageParam: 0,
          queryKey: ["second-failing-infinite-query"],
          queryFn: async () => {
            throw secondError;
          },
        },
        onError,
      ),
    ]);

    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(firstError);
    expect(onError).toHaveBeenCalledWith(secondError);
  });
});

for (const [name, load] of Object.entries({
  route: ensureRouteQueryData,
  critical: ensureCriticalQueryData,
  fetch: fetchRouteQuery,
})) {
  test(`keeps a ${name} read alive when its last component observer leaves`, async () => {
    const queryClient = new QueryClient();
    const rows = Promise.withResolvers<string>();
    let aborted = false;
    const read = mock(
      async ({ signal }: Pick<QueryFunctionContext, "signal">) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
        return await rows.promise;
      },
    );
    const options = queryOptions({
      queryKey: ["route-read-ownership"],
      queryFn: read,
    });
    const component = new QueryObserver(queryClient, options);
    const unmount = component.subscribe(() => undefined);
    const routeRead = load(queryClient, options);
    unmount();
    rows.resolve("rows");
    expect(await routeRead).toBe("rows");
    expect(aborted).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: options.queryKey })
        ?.getObserversCount(),
    ).toBe(0);
    queryClient.clear();
  });
}

test("a cached route read does not cancel a background refresh", async () => {
  const queryClient = new QueryClient();
  const rows = Promise.withResolvers<string>();
  let aborted = false;
  const read = mock(
    async ({ signal }: Pick<QueryFunctionContext, "signal">) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      return await rows.promise;
    },
  );
  const options = queryOptions({
    queryKey: ["cached-route-read-ownership"],
    queryFn: read,
  });
  queryClient.setQueryData(options.queryKey, "cached rows");
  const refresh = queryClient.query({ ...options, staleTime: 0 });
  expect(await ensureRouteQueryData(queryClient, options)).toBe("cached rows");
  expect(aborted).toBe(false);
  rows.resolve("refreshed rows");
  expect(await refresh).toBe("refreshed rows");
  expect(
    queryClient
      .getQueryCache()
      .find({ queryKey: options.queryKey })
      ?.getObserversCount(),
  ).toBe(0);
  queryClient.clear();
});

test("keeps an infinite route read alive when its last component observer leaves", async () => {
  const queryClient = new QueryClient();
  const rows = Promise.withResolvers<string>();
  let aborted = false;
  const read = mock(
    async ({ signal }: Pick<QueryFunctionContext, "signal">) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      return await rows.promise;
    },
  );
  const options = infiniteQueryOptions({
    queryKey: ["infinite-route-read-ownership"],
    queryFn: read,
    initialPageParam: null,
    getNextPageParam: () => undefined,
  });
  const component = new InfiniteQueryObserver(queryClient, options);
  const unmount = component.subscribe(() => undefined);
  const routeRead = ensureRouteInfiniteQueryData(queryClient, options);
  unmount();
  rows.resolve("rows");
  expect(await routeRead).toEqual({ pages: ["rows"], pageParams: [null] });
  expect(aborted).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  expect(
    queryClient
      .getQueryCache()
      .find({ queryKey: options.queryKey })
      ?.getObserversCount(),
  ).toBe(0);
  queryClient.clear();
});
