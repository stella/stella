import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import {
  REALTIME_EVENT_TYPE,
  RESOURCE_TYPE,
  resourceMutationDigest,
} from "@stll/api-contract";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
const { act, renderHook, cleanup } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider, QueryObserver } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { useCreateTask } = await import("@/lib/workspaces/mutations/tasks");
const { getWorkspaceRealtimeQueryActions } =
  await import("@/lib/workspace-realtime");
const { handleWorkspaceMutationEvent } =
  await import("@/lib/workspace-mutation");
const { workspacesKeys } = await import("@/lib/workspaces/queries.logic");
const { taskKeys } = await import("@/lib/workspaces/queries/tasks.logic");
const workspaceId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";

afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

for (const rowCount of [10, 100]) {
  test(`creating a task and receiving its event refreshes each projection once with ${rowCount} rows`, async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    const counts = new Map<string, number>();
    const keys = [
      workspacesKeys.overview(workspaceId),
      workspacesKeys.overviewActivityAll(workspaceId),
      taskKeys.detail(workspaceId, taskId),
    ];
    const subscriptions = keys.map((queryKey) => {
      client.setQueryData(
        queryKey,
        Array.from({ length: rowCount }, (_, id) => id),
      );
      return new QueryObserver(client, {
        queryKey,
        queryFn: async () => {
          const key = JSON.stringify(queryKey);
          counts.set(key, (counts.get(key) ?? 0) + 1);
          return [];
        },
      }).subscribe(() => undefined);
    });
    const originalFetch = globalThis.fetch;
    let mutationId: string | undefined;
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        mutationId =
          new Headers(init?.headers).get("x-stella-mutation-id") ?? undefined;
        return Response.json({ entityId: taskId });
      },
      { preconnect: () => undefined },
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages}>
          {children}
        </IntlProvider>
      </QueryClientProvider>
    );
    const hook = renderHook(() => useCreateTask(), { wrapper });
    try {
      await act(async () => {
        await hook.result.current.mutateAsync(workspaceId);
      });
      expect(mutationId).toBeDefined();
      const event = {
        type: REALTIME_EVENT_TYPE.RESOURCE_SET_UPDATED,
        resourceType: RESOURCE_TYPE.ENTITY,
        mutationDigest: await resourceMutationDigest(mutationId ?? ""),
      } as const;
      const refreshes: Promise<void>[] = [];
      handleWorkspaceMutationEvent(client, event, () => {
        for (const action of getWorkspaceRealtimeQueryActions(
          event,
          workspaceId,
        )) {
          refreshes.push(
            client.invalidateQueries({ queryKey: action.queryKey }),
          );
        }
      });
      await Promise.all(refreshes);
      expect(keys.map((key) => counts.get(JSON.stringify(key)) ?? 0)).toEqual([
        1, 1, 1,
      ]);
    } finally {
      hook.unmount();
      globalThis.fetch = originalFetch;
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
      client.clear();
    }
  });
}
