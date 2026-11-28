import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import {
  resourceQueryOptions,
  useResourceMutation,
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

describe("useResourceMutation", () => {
  test("invalidates matching workspace resource queries and leaves other workspaces fresh", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    try {
      const readerA = resourceQueryOptions(
        {
          queryKey: ["time-entries", WORKSPACE_A] as const,
          queryFn: async () => ["a"],
        },
        {
          resources: [RESOURCE_TYPE.TIME_ENTRY],
          scope: { type: "workspace", workspaceId: WORKSPACE_A },
        },
      );
      const readerB = resourceQueryOptions(
        {
          queryKey: ["time-entries", WORKSPACE_B] as const,
          queryFn: async () => ["b"],
        },
        {
          resources: [RESOURCE_TYPE.TIME_ENTRY],
          scope: { type: "workspace", workspaceId: WORKSPACE_B },
        },
      );
      await queryClient.query(readerA);
      await queryClient.query(readerB);

      const { result } = renderHook(
        () =>
          useResourceMutation({
            resource: { mutation: "createTimeEntry" },
            mutationFn: async ({ workspaceId }: { workspaceId: string }) => ({
              createdIn: workspaceId,
            }),
          }),
        { wrapper: createWrapper(queryClient) },
      );

      let response: { createdIn: string } | undefined;
      await act(async () => {
        response = await result.current.mutateAsync({
          workspaceId: WORKSPACE_A,
        });
      });

      expect(response).toEqual({ createdIn: WORKSPACE_A });
      expect(queryClient.getQueryState(readerA.queryKey)?.isInvalidated).toBe(
        true,
      );
      expect(queryClient.getQueryState(readerB.queryKey)?.isInvalidated).toBe(
        false,
      );
    } finally {
      queryClient.clear();
    }
  });

  test('explicit { type: "none", reason } opt-out executes without invalidating cached queries', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    try {
      const reader = resourceQueryOptions(
        {
          queryKey: ["properties", WORKSPACE_A] as const,
          queryFn: async () => ["prop-1"],
        },
        {
          resources: [RESOURCE_TYPE.PROPERTY],
          scope: { type: "workspace", workspaceId: WORKSPACE_A },
        },
      );
      await queryClient.query(reader);

      const onSuccessCalls: {
        data: string;
        context: { tag: string } | undefined;
      }[] = [];
      const { result } = renderHook(
        () =>
          useResourceMutation({
            resource: {
              type: "none",
              reason:
                "Pure client-only suggestion draft does not mutate server state.",
            },
            mutationFn: async (prompt: string) => `refined:${prompt}`,
            onMutate: () => ({ tag: "ctx" }),
            onSuccess: (data, _vars, context) => {
              onSuccessCalls.push({ data, context });
            },
          }),
        { wrapper: createWrapper(queryClient) },
      );

      await act(async () => {
        await result.current.mutateAsync("hello");
      });

      await waitFor(() => {
        expect(onSuccessCalls).toEqual([
          { data: "refined:hello", context: { tag: "ctx" } },
        ]);
      });
      expect(queryClient.getQueryState(reader.queryKey)?.isInvalidated).toBe(
        false,
      );
    } finally {
      queryClient.clear();
    }
  });
});

// Compile-time type contract checks (never executed at runtime).
const useResourceMutationTypeContracts = () => {
  // Valid: workspace-scoped mutation with workspaceId in variables
  const validWorkspace = useResourceMutation({
    resource: { mutation: "createTimeEntry" },
    mutationFn: async (_vars: { workspaceId: string; minutes: number }) =>
      "ok" as const,
  });
  const _validWorkspaceData: "ok" | undefined = validWorkspace.data;

  // Valid: organization-scoped mutation with void variables
  useResourceMutation({
    resource: {
      mutation: "deleteWorkspace",
      scope: { type: "organization" },
    },
    mutationFn: async () => undefined,
  });

  // Valid: explicit opt-out
  useResourceMutation({
    resource: { type: "none", reason: "Client-only action." },
    mutationFn: async (_vars: { text: string }) => 42,
  });

  // @ts-expect-error -- callers cannot omit the resource declaration
  useResourceMutation({
    mutationFn: async (_vars: { workspaceId: string }) => "missing-resource",
  });

  useResourceMutation({
    // @ts-expect-error -- unknown contract name is rejected at compile time
    resource: { mutation: "nonExistentContract" },
    mutationFn: async (_vars: { workspaceId: string }) => undefined,
  });

  useResourceMutation({
    // @ts-expect-error -- workspace-scoped mutations require workspaceId in variables
    resource: { mutation: "createTimeEntry" },
    mutationFn: async (_vars: { minutes: number }) => undefined,
  });

  const rename = useResourceMutation({
    resource: { mutation: "renameEntity" },
    mutationFn: async (_vars: { workspaceId: string; entityId: string }) =>
      undefined,
  });
  // @ts-expect-error -- changedEntity contracts require the entity id variable at call time
  rename.mutate({ workspaceId: "ws-1" });

  useResourceMutation({
    // @ts-expect-error -- explicit opt-out requires a reason string
    resource: { type: "none" },
    mutationFn: async () => undefined,
  });

  return _validWorkspaceData;
};

void useResourceMutationTypeContracts;
