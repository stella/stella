import { QueryClient } from "@tanstack/react-query";
import { describe, expect, setSystemTime, test } from "bun:test";

import {
  PROFESSIONAL_USE_STATEMENT_VERSION,
  PROFESSIONAL_USE_STATUS,
  PROFESSIONAL_USE_TERMS_VERSION,
} from "@stll/api-contract/professional-use";

import {
  professionalUseOptions,
  refreshAuthQueries,
  rootKeys,
} from "@/lib/auth-queries";
import {
  ensureRouteQueryData,
  ROUTE_QUERY_STALE_TIME_MS,
} from "@/lib/react-query";

describe("professional-use route caching", () => {
  test("retains acceptance across route reads while isolating fresh query clients", async () => {
    const queryClient = new QueryClient();
    const freshQueryClient = new QueryClient();
    const now = new Date("2026-01-15T12:00:00.000Z");
    let fetchCount = 0;
    const options = {
      ...professionalUseOptions("accepted-user"),
      queryFn: async () => {
        fetchCount += 1;
        return {
          status: PROFESSIONAL_USE_STATUS.accepted,
          statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION,
          termsVersion: PROFESSIONAL_USE_TERMS_VERSION,
          acceptedAt: now.toISOString(),
        };
      },
    };

    setSystemTime(now);
    try {
      const accepted = await ensureRouteQueryData(queryClient, options);
      expect(accepted.status).toBe(PROFESSIONAL_USE_STATUS.accepted);
      expect(await ensureRouteQueryData(queryClient, options)).toEqual(
        accepted,
      );
      setSystemTime(now.getTime() + ROUTE_QUERY_STALE_TIME_MS + 1);
      expect(await ensureRouteQueryData(queryClient, options)).toEqual(
        accepted,
      );
      expect(fetchCount).toBe(1);

      expect(await ensureRouteQueryData(freshQueryClient, options)).toEqual(
        accepted,
      );
      expect(await ensureRouteQueryData(freshQueryClient, options)).toEqual(
        accepted,
      );
      expect(fetchCount).toBe(2);
    } finally {
      setSystemTime();
      queryClient.clear();
      freshQueryClient.clear();
    }
  });
});

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
