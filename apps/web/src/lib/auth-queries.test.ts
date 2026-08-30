import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { refreshAuthQueries, rootKeys } from "@/lib/auth-queries";

describe("auth query refresh", () => {
  test("refreshes inactive session and role caches together", async () => {
    const queryClient = new QueryClient();
    let sessionFetchCount = 0;
    let roleFetchCount = 0;
    const sessionQuery = {
      queryKey: rootKeys.session,
      queryFn: async () => {
        sessionFetchCount += 1;
        return sessionFetchCount;
      },
    };
    const roleQuery = {
      queryKey: rootKeys.role,
      queryFn: async () => {
        roleFetchCount += 1;
        return roleFetchCount;
      },
    };

    await Promise.all([
      queryClient.query(sessionQuery),
      queryClient.query(roleQuery),
    ]);
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: rootKeys.session })
        ?.getObserversCount(),
    ).toBe(0);
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: rootKeys.role })
        ?.getObserversCount(),
    ).toBe(0);
    await refreshAuthQueries(queryClient);

    expect(sessionFetchCount).toBe(2);
    expect(roleFetchCount).toBe(2);
  });
});
