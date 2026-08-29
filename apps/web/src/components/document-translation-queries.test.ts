import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { invalidateDocumentTranslationOutputQueries } from "@/components/document-translation-queries";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

describe("document translation output invalidation", () => {
  test("refetches active projections without refetching the open document", async () => {
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
    const collectionKey = [...entitiesKeys.all("workspace-a"), "collection"];
    let collectionFetches = 0;
    const collectionObserver = new QueryObserver(queryClient, {
      queryKey: collectionKey,
      queryFn: async () => {
        collectionFetches += 1;
        return [];
      },
    });
    const unsubscribe = observer.subscribe(() => undefined);
    const unsubscribeCollection = collectionObserver.subscribe(() => undefined);
    await observer.refetch();
    await collectionObserver.refetch();

    await invalidateDocumentTranslationOutputQueries(
      queryClient,
      "workspace-a",
      "source-entity",
    );

    expect(fetches).toBe(1);
    expect(collectionFetches).toBe(3);
    expect(queryClient.getQueryState(activeDocumentKey)?.isInvalidated).toBe(
      false,
    );
    unsubscribe();
    unsubscribeCollection();
  });
});
