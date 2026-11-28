import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import {
  useResourceMutation,
  useResourceQuery,
} from "@/lib/workspace-realtime";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const WORKSPACE_A = "00000000-0000-4000-8000-000000000001";
const WORKSPACE_B = "00000000-0000-4000-8000-000000000002";

const createWrapper =
  (queryClient: QueryClient) =>
  ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

describe("useResourceQuery", () => {
  test("attaches resourceReads metadata and invalidates only matching workspace queries", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    try {
      const keyA = ["time-entries", WORKSPACE_A] as const;
      const keyB = ["time-entries", WORKSPACE_B] as const;
      let fetchesA = 0;
      let fetchesB = 0;

      const { result } = renderHook(
        () => ({
          queryA: useResourceQuery({
            queryKey: keyA,
            queryFn: async () => {
              fetchesA += 1;
              return ["a", fetchesA];
            },
            meta: { source: "test" },
            resourceReads: {
              resources: [RESOURCE_TYPE.TIME_ENTRY],
              scope: { type: "workspace", workspaceId: WORKSPACE_A },
            },
          }),
          queryB: useResourceQuery({
            queryKey: keyB,
            queryFn: async () => {
              fetchesB += 1;
              return ["b", fetchesB];
            },
            resourceReads: {
              resources: [RESOURCE_TYPE.TIME_ENTRY],
              scope: { type: "workspace", workspaceId: WORKSPACE_B },
            },
          }),
          createEntry: useResourceMutation({
            resource: { mutation: "createTimeEntry" },
            mutationFn: async ({ workspaceId }: { workspaceId: string }) => ({
              workspaceId,
            }),
          }),
        }),
        { wrapper: createWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(result.current.queryA.data).toEqual(["a", 1]);
        expect(result.current.queryB.data).toEqual(["b", 1]);
      });

      const cachedA = queryClient.getQueryCache().find({ queryKey: keyA });
      expect(cachedA?.meta).toEqual({
        source: "test",
        resourceReads: {
          resources: [RESOURCE_TYPE.TIME_ENTRY],
          scope: { type: "workspace", workspaceId: WORKSPACE_A },
        },
      });

      await act(async () => {
        await result.current.createEntry.mutateAsync({
          workspaceId: WORKSPACE_A,
        });
      });

      await waitFor(() => {
        expect(result.current.queryA.data).toEqual(["a", 2]);
      });
      expect(fetchesA).toBe(2);
      expect(fetchesB).toBe(1);
      expect(queryClient.getQueryState(keyB)?.isInvalidated).toBe(false);
    } finally {
      queryClient.clear();
    }
  });

  test('explicit { type: "independent" } query executes with select and is not invalidated by workspace mutations', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    try {
      const key = ["independent-preview", WORKSPACE_A] as const;

      const { result } = renderHook(
        () => ({
          preview: useResourceQuery({
            queryKey: key,
            queryFn: async () => ({ count: 3 }),
            select: (data) => data.count * 2,
            resourceReads: { type: "independent" },
          }),
          createEntry: useResourceMutation({
            resource: { mutation: "createTimeEntry" },
            mutationFn: async ({ workspaceId }: { workspaceId: string }) => ({
              workspaceId,
            }),
          }),
        }),
        { wrapper: createWrapper(queryClient) },
      );

      await waitFor(() => {
        expect(result.current.preview.data).toBe(6);
      });

      await act(async () => {
        await result.current.createEntry.mutateAsync({
          workspaceId: WORKSPACE_A,
        });
      });

      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    } finally {
      queryClient.clear();
    }
  });
});

// Compile-time type contract checks (never executed at runtime).
const useResourceQueryTypeContracts = () => {
  // Valid: workspace-scoped reader with inferred queryFn return type
  const workspaceQuery = useResourceQuery({
    queryKey: ["time-entries", WORKSPACE_A] as const,
    queryFn: async () => ({ total: 5 }),
    resourceReads: {
      resources: [RESOURCE_TYPE.TIME_ENTRY],
      scope: { type: "workspace", workspaceId: WORKSPACE_A },
    },
  });
  const _workspaceTotal: number | undefined = workspaceQuery.data?.total;

  // Valid: select transforms TQueryFnData -> TData
  const selectedQuery = useResourceQuery({
    queryKey: ["time-entries", WORKSPACE_A, "count"] as const,
    queryFn: async () => ["a", "b"],
    select: (items) => items.length,
    resourceReads: {
      resources: [RESOURCE_TYPE.TIME_ENTRY],
      scope: { type: "workspace", workspaceId: WORKSPACE_A },
    },
  });
  const _selectedCount: number | undefined = selectedQuery.data;

  // Valid: initialData narrows data to defined TData
  const definedQuery = useResourceQuery({
    queryKey: ["independent-defined"] as const,
    queryFn: async () => "live",
    initialData: "initial",
    resourceReads: { type: "independent" },
  });
  const _definedData: string = definedQuery.data;

  // Valid: keptCurrentBy accepts registered contract names
  useResourceQuery({
    queryKey: ["entities", WORKSPACE_A] as const,
    queryFn: async () => [],
    resourceReads: {
      resources: [RESOURCE_TYPE.ENTITY],
      scope: { type: "workspace", workspaceId: WORKSPACE_A },
      keptCurrentBy: ["renameEntity"],
    },
  });

  // @ts-expect-error -- callers cannot omit resourceReads
  useResourceQuery({
    queryKey: ["missing-reads"] as const,
    queryFn: async () => "nope",
  });

  useResourceQuery({
    queryKey: ["empty-resources"] as const,
    queryFn: async () => "nope",
    resourceReads: {
      // @ts-expect-error -- resources tuple must be non-empty
      resources: [],
      scope: { type: "workspace", workspaceId: WORKSPACE_A },
    },
  });

  useResourceQuery({
    queryKey: ["unknown-kept-current"] as const,
    queryFn: async () => "nope",
    resourceReads: {
      resources: [RESOURCE_TYPE.ENTITY],
      scope: { type: "workspace", workspaceId: WORKSPACE_A },
      // @ts-expect-error -- unknown contract name is rejected at compile time
      keptCurrentBy: ["nonExistentContract"],
    },
  });

  useResourceQuery({
    queryKey: ["invalid-type"] as const,
    queryFn: async () => "nope",
    // @ts-expect-error -- independent declaration requires exact type literal
    resourceReads: { type: "none" },
  });

  return [_workspaceTotal, _selectedCount, _definedData] as const;
};

void useResourceQueryTypeContracts;
