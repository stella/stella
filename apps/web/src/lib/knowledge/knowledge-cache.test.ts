import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { publicKnowledgeKeys } from "@/features/knowledge/public/public-knowledge-queries";
import { resetKnowledgeCache } from "@/lib/knowledge/knowledge-cache";
import { knowledgeKeys } from "@/lib/knowledge/queries";

const ORG_A = "org-a";

describe("resetKnowledgeCache", () => {
  test("drops an organization's Knowledge and keeps the catalogue", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      knowledgeKeys.templates.list(ORG_A, { categoryId: null, limit: 50 }),
      { items: [{ id: "tpl-a" }] },
    );
    queryClient.setQueryData(knowledgeKeys.playbooks.all(ORG_A), {
      items: [],
    });
    queryClient.setQueryData(publicKnowledgeKeys.templates.catalogue(), []);

    await resetKnowledgeCache(queryClient);

    const remaining = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(remaining).toEqual([publicKnowledgeKeys.templates.catalogue()]);
  });

  // A read that started for the previous session must not land in the cache
  // once the next one has begun.
  test("cancels a read still in flight", async () => {
    const queryClient = new QueryClient();
    const key = knowledgeKeys.templates.all(ORG_A);
    let resolveRead: (value: string) => void = () => undefined;
    const read = queryClient.fetchQuery({
      queryKey: key,
      queryFn: () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    });

    await resetKnowledgeCache(queryClient);
    resolveRead("org-a data");
    await read.catch(() => undefined);

    expect(queryClient.getQueryData(key)).toBeUndefined();
    expect(queryClient.getQueryCache().find({ queryKey: key })).toBeUndefined();
  });
});
