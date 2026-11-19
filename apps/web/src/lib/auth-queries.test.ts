import { QueryClient } from "@tanstack/react-query";
import { describe, expect, setSystemTime, test } from "bun:test";

import {
  PROFESSIONAL_USE_STATEMENT_VERSION,
  PROFESSIONAL_USE_STATUS,
  PROFESSIONAL_USE_TERMS_VERSION,
} from "@stll/api-contract/professional-use";

import { MEMBER_SESSION } from "@/lib/account/auth-session.test-fixtures";
import {
  professionalUseOptions,
  refreshAuthQueries,
  roleOptions,
  sessionOptions,
} from "@/lib/auth-queries";
import {
  ensureRouteQueryData,
  ROUTE_QUERY_STALE_TIME_MS,
} from "@/lib/react-query";
import { installSessionCacheGuard } from "@/lib/session-cache-guard";

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
  test("refreshes inactive session and role caches in owner order", async () => {
    const originalFetch = globalThis.fetch;
    const queryClient = new QueryClient();
    const uninstall = installSessionCacheGuard(queryClient, {
      isAuthFlowPage: () => false,
      reloadDocument: () => undefined,
      reloadDocumentAt: () => undefined,
    });
    let sessionFetchCount = 0;
    let roleFetchCount = 0;
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.pathname.endsWith("/get-session")) {
          sessionFetchCount += 1;
          return Response.json({
            ...MEMBER_SESSION,
            session: {
              ...MEMBER_SESSION.session,
              activeOrganizationId: sessionFetchCount === 1 ? "org-a" : "org-b",
            },
          });
        }
        if (url.pathname.endsWith("/get-active-member-role")) {
          roleFetchCount += 1;
          return Response.json({
            role: roleFetchCount === 1 ? "owner" : "member",
          });
        }
        throw new Error(`Unexpected auth request: ${url.pathname}`);
      },
      { preconnect: () => undefined },
    );
    try {
      await queryClient.query(sessionOptions);
      await queryClient.query(roleOptions);
      expect(
        queryClient.getQueryCache().find(sessionOptions)?.getObserversCount(),
      ).toBe(0);
      expect(
        queryClient.getQueryCache().find(roleOptions)?.getObserversCount(),
      ).toBe(0);
      await refreshAuthQueries(queryClient);
      expect(sessionFetchCount).toBe(2);
      expect(roleFetchCount).toBe(2);
      expect(
        queryClient.getQueryData(sessionOptions.queryKey)?.session
          .activeOrganizationId,
      ).toBe("org-b");
      expect(queryClient.getQueryData(roleOptions.queryKey)).toBe("member");
      expect(
        queryClient.getQueryCache().find(roleOptions)?.getObserversCount(),
      ).toBe(0);
    } finally {
      uninstall();
      queryClient.clear();
      globalThis.fetch = originalFetch;
    }
  });
});
