import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import path from "node:path";

import { deleteMatterQueries } from "@/lib/workspaces/delete-matter-queries";
import {
  overviewOptions,
  workspaceOptions,
  workspacesOptions,
} from "@/lib/workspaces/queries";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";
import { viewsOptions } from "@/lib/workspaces/queries/views";
import { workflowOptions } from "@/lib/workspaces/queries/workspace";

const WORKSPACE_ID = "workspace-to-delete";
const ORGANIZATION_ID = "organization";
const USER_ID = "user";

describe("deleted entity query ownership", () => {
  test("removes observed matter queries and invalidates only its collections", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const detailObserver = new QueryObserver(queryClient, {
      ...workspaceOptions(WORKSPACE_ID),
      enabled: false,
    });
    const overviewObserver = new QueryObserver(queryClient, {
      ...overviewOptions(WORKSPACE_ID),
      enabled: false,
    });
    const workflowObserver = new QueryObserver(queryClient, {
      ...workflowOptions({ key: { workspaceId: WORKSPACE_ID } }),
      enabled: false,
    });
    const unsubscribes = [
      detailObserver.subscribe(() => undefined),
      overviewObserver.subscribe(() => undefined),
      workflowObserver.subscribe(() => undefined),
    ];
    queryClient.setQueryData(propertiesOptions(WORKSPACE_ID).queryKey, []);
    queryClient.setQueryData(viewsOptions(WORKSPACE_ID).queryKey, []);
    const listKey = workspacesOptions(ORGANIZATION_ID).queryKey;
    queryClient.setQueryData(listKey, { workspaces: [] });

    await deleteMatterQueries({
      activeOrganizationId: ORGANIZATION_ID,
      queryClient,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
    });

    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .filter(({ queryKey }) => queryKey.includes(WORKSPACE_ID)),
    ).toEqual([]);
    expect(queryClient.isFetching()).toBe(0);
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);

    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }
    queryClient.clear();
  });

  test("matter delete success uses the deletion helper", async () => {
    const source = await Bun.file(
      path.resolve(
        import.meta.dir,
        "../../components/workspaces/matter-context-menu.tsx",
      ),
    ).text();
    expect(deleteSuccessWithoutHelper(source)).toEqual([]);
  });

  test("census fixture catches family invalidation after deletion", () => {
    const fixture = `
      await deleteWorkspace.mutateAsync({ workspaceId }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: workspacesKeys.all });
        },
        onError: reportError,
      });
    `;
    expect(deleteSuccessWithoutHelper(fixture)).toEqual([
      "deleteWorkspace.mutateAsync",
    ]);
  });
});

const deleteSuccessWithoutHelper = (source: string): string[] =>
  [
    ...source.matchAll(
      /\b(delete\w*)\.mutateAsync\([\s\S]*?onSuccess:\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\s*\},\n\s*onError:/gu,
    ),
  ].flatMap(([, mutation, success]) =>
    mutation !== undefined &&
    success !== undefined &&
    success.includes("invalidateQueries") &&
    !success.includes("deleteEntityQueries") &&
    !success.includes("deleteMatterQueries")
      ? [`${mutation}.mutateAsync`]
      : [],
  );
