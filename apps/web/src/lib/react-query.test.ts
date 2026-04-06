import { QueryClient } from "@tanstack/react-query";
import { describe, expect, mock, test } from "bun:test";

import { prefetchNonCriticalQuery } from "@/lib/react-query";

describe("prefetchNonCriticalQuery", () => {
  test("reports errors through onError", async () => {
    const queryClient = new QueryClient();
    const expectedError = new Error("boom");
    const onError = mock((error: unknown) => error);

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
    const onError = mock((error: unknown) => error);

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
