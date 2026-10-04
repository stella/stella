import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { publicKnowledgeKeys } from "@/features/knowledge/public/public-knowledge-queries";
import {
  resetKnowledgeCache,
  resetVisitorCache,
} from "@/lib/knowledge/knowledge-cache";
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
    const read = queryClient.query({
      queryKey: key,
      queryFn: async () =>
        await new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    });

    await resetKnowledgeCache(queryClient);
    resolveRead("org-a data");
    // swallow-ok: cache reset deliberately cancels the read; cache absence is asserted below
    await read.catch(() => undefined);

    expect(queryClient.getQueryCache().find({ queryKey: key })).toBeUndefined();
  });
});

describe("resetVisitorCache", () => {
  test("keeps only what says who is visiting", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["session"], null);
    queryClient.setQueryData(["role"], "owner");
    queryClient.setQueryData(["workspaces", "navigation", ORG_A], []);
    queryClient.setQueryData(["catalogue", ORG_A, "list"], []);
    queryClient.setQueryData(publicKnowledgeKeys.templates.catalogue(), []);

    await resetVisitorCache(queryClient, [["session"], ["role"]]);

    const remaining = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(remaining).toEqual([["session"], ["role"]]);
  });

  test("drops a query still on screen and cancels its read", async () => {
    const queryClient = new QueryClient();
    const key = ["workspaces", "navigation", ORG_A];
    let resolveRead: (value: string[]) => void = () => undefined;
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: async () =>
        await new Promise<string[]>((resolve) => {
          resolveRead = resolve;
        }),
    });
    const unsubscribe = observer.subscribe(() => undefined);

    await resetVisitorCache(queryClient, [["session"]]);
    resolveRead(["matter of org-a"]);
    await Promise.resolve();

    expect(queryClient.getQueryCache().find({ queryKey: key })).toBeUndefined();
    unsubscribe();
  });
});
