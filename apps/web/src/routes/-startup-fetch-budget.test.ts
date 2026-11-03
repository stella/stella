import { InfiniteQueryObserver, QueryObserver } from "@tanstack/react-query";
import { expect, test } from "bun:test";

import { aiAvailableResponse } from "@/__fixtures__/ai-availability";
import { groupedChatThreadsOptions } from "@/features/chat/queries";
import type { WebApiRoutes } from "@/lib/api";
import { rootKeys } from "@/lib/auth-queries";
import { aiAvailabilityOptions } from "@/lib/organization/ai-config-queries";
import { createAppQueryClient } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import {
  installSessionCacheGuard,
  resetAuthTransition,
  settleAuthTransition,
} from "@/lib/session-cache-guard";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import { startSignedInShellRequests } from "@/routes/-protected-guard";

const caller = { organizationId: "org-fixture", userId: "member-fixture" };
const session = {
  user: { id: caller.userId },
  session: {
    userId: caller.userId,
    activeOrganizationId: caller.organizationId,
  },
};

for (const rowCount of [10, 100]) {
  test(`shell prefetch and repeated consumers share one request through session settlement with ${rowCount} rows`, async () => {
    const client = createAppQueryClient();
    const counts = new Map<string, number>();
    const originalFetch = globalThis.fetch;
    const rows = Array.from({ length: rowCount }, (_, index) => ({
      id: toSafeId<"workspace">(
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      ),
      name: `Matter ${index}`,
      reference: `M-${index}`,
      clientId: null,
      client: null,
      color: null,
      defaultViewId: null,
      status: "active" as const,
      lastActivityAt: "2026-10-01T00:00:00.000Z",
    }));
    const navigation = {
      items: rows,
      workspaces: rows,
      limit: 100,
      nextCursor: null,
      features: { timeBilling: false },
    } satisfies WebApiRoutes["workspaces"]["navigation"]["get"]["response"][200];
    const threads = {
      global: [],
      workspaces: [],
      nextCursor: null,
    } satisfies WebApiRoutes["chat"]["threads"]["get"]["response"][200];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
        if (url.pathname.endsWith("/workspaces/navigation")) {
          return Response.json(navigation);
        }
        if (url.pathname.endsWith("/organization-settings/ai-availability")) {
          return Response.json(aiAvailableResponse());
        }
        if (url.pathname.endsWith("/chat/threads")) {
          return Response.json(threads);
        }
        return Response.json(null, { status: 404 });
      },
      { preconnect: () => undefined },
    );
    const unsubscribeGuard = installSessionCacheGuard(client, {
      isAuthFlowPage: () => false,
      reloadDocument: () => undefined,
      reloadDocumentAt: () => undefined,
    });
    client.setQueryData(rootKeys.session, session);
    const ai = aiAvailabilityOptions({ organizationId: caller.organizationId });
    const navigationOptions = workspacesNavigationOptions(caller);
    const history = groupedChatThreadsOptions({
      activeOrganizationId: caller.organizationId,
      userId: caller.userId,
    });
    const subscriptions: (() => void)[] = [];
    const mountConsumers = () => {
      subscriptions.push(
        new QueryObserver(client, ai).subscribe(() => undefined),
      );
      subscriptions.push(
        new QueryObserver(client, navigationOptions).subscribe(() => undefined),
      );
      subscriptions.push(
        new InfiniteQueryObserver(client, history).subscribe(() => undefined),
      );
    };
    try {
      startSignedInShellRequests({ queryClient: client, ...caller });
      mountConsumers();
      await Promise.all([
        client.query(ai),
        client.query(navigationOptions),
        client.infiniteQuery(history),
      ]);
      client.setQueryData(rootKeys.session, session);
      await settleAuthTransition(client);
      await resetAuthTransition(
        client,
        `member:${caller.userId}:${caller.organizationId}`,
      );
      mountConsumers();
      await Promise.all([
        client.query(ai),
        client.query(navigationOptions),
        client.infiniteQuery(history),
      ]);
      expect([...counts.values()]).toEqual([1, 1, 1]);
      expect(counts.size).toBe(3);
    } finally {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
      unsubscribeGuard();
      client.clear();
      globalThis.fetch = originalFetch;
    }
  });
}
