import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { refreshAuthQueries, rootKeys } from "@/lib/auth-queries";

describe("auth query refresh", () => {
  test("refreshes inactive session and role caches together", async () => {
    const queryClient = new QueryClient();
    let sessionVersion = 0;
    let roleVersion = 0;
    const sessionQuery = {
      queryKey: rootKeys.session,
      queryFn: () => Promise.resolve(sessionVersion),
    };
    const roleQuery = {
      queryKey: rootKeys.role,
      queryFn: () => Promise.resolve(roleVersion),
    };

    await Promise.all([
      queryClient.fetchQuery(sessionQuery),
      queryClient.fetchQuery(roleQuery),
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
    sessionVersion = 1;
    roleVersion = 1;

    await refreshAuthQueries(queryClient);

    expect(queryClient.getQueryData(rootKeys.session)).toBe(1);
    expect(queryClient.getQueryData(rootKeys.role)).toBe(1);
  });
});
