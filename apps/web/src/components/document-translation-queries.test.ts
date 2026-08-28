import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { invalidateDocumentTranslationOutputQueries } from "@/components/document-translation-queries";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

describe("document translation output invalidation", () => {
  test("marks entity projections stale without refetching the open document", async () => {
    const queryClient = new QueryClient();
    const activeDocumentKey = entitiesKeys.detail(
      "workspace-a",
      "source-entity",
    );
    let fetches = 0;
    const observer = new QueryObserver(queryClient, {
      queryKey: activeDocumentKey,
      queryFn: async () => {
        fetches += 1;
        return { id: "source-entity" };
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await observer.refetch();

    await invalidateDocumentTranslationOutputQueries(
      queryClient,
      "workspace-a",
    );

    expect(fetches).toBe(1);
    expect(queryClient.getQueryState(activeDocumentKey)?.isInvalidated).toBe(
      true,
    );
    unsubscribe();
  });
});
