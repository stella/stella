import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects broad all-key invalidation in mutation callbacks", async () => {
  expect(
    await lintSingleRule(
      "query-invalidation-scope",
      "useMutation({ onSuccess: () => queryClient.invalidateQueries({ queryKey: entitiesKeys.all(workspaceId) }) });",
    ),
  ).toEqual([1]);
});

test("accepts narrow mutation invalidation", async () => {
  expect(
    await lintSingleRule(
      "query-invalidation-scope",
      "useMutation({ onSettled: () => queryClient.invalidateQueries({ queryKey: entitiesKeys.detail(workspaceId, entityId) }) });",
    ),
  ).toEqual([]);
});

test("rejects unbounded infinite hooks and option factories", async () => {
  expect(
    await lintSingleRule(
      "query-invalidation-scope",
      "useInfiniteQuery({ queryKey: ['a'] });\ninfiniteQueryOptions({ queryKey: ['b'] });",
    ),
  ).toEqual([1, 2]);
});

test("accepts infinite queries with a page budget", async () => {
  expect(
    await lintSingleRule(
      "query-invalidation-scope",
      "useInfiniteQuery({ queryKey: ['a'], maxPages: 3 });",
    ),
  ).toEqual([]);
});

test("rejects entity-root invalidation extracted into a helper", async () => {
  expect(
    await lintSingleRule(
      "query-invalidation-scope",
      `
    export const invalidateEntityQueries = () => queryClient.invalidateQueries({
      queryKey: entitiesKeys.all(workspaceId),
    });
  `,
    ),
  ).toEqual([2]);
});

test("accepts collection predicates and independently targeted detail invalidation", async () => {
  expect(
    await lintSingleRule(
      "query-invalidation-scope",
      `
    queryClient.invalidateQueries({ queryKey: entitiesKeys.all(workspaceId), predicate: ({ queryKey }) => isEntityCollectionQueryKey(queryKey) });
    queryClient.invalidateQueries({ queryKey: entitiesKeys.all(workspaceId), predicate: ({ queryKey: key }) => isEntityCollectionQueryKey(key) });
    queryClient.invalidateQueries({ queryKey: entitiesKeys.detail(workspaceId, entityId) });
    queryClient.invalidateQueries({ queryKey: inboxKeys.all(workspaceId) });
    queryClient.invalidateQueries({ queryKey: entityViewKeys.all(workspaceId) });
  `,
    ),
  ).toEqual([]);
});

test("rejects predicates that do not constrain the invalidated query", async () => {
  expect(
    await lintSingleRule(
      "query-invalidation-scope",
      `
    queryClient.invalidateQueries({ queryKey: entitiesKeys.all(workspaceId), predicate: () => true });
    queryClient.invalidateQueries({ queryKey: entitiesKeys.all(workspaceId), predicate: ({ queryKey }) => isEntityCollectionQueryKey(otherKey) });
    queryClient.invalidateQueries({ queryKey: entitiesKeys.all(workspaceId), predicate: ({ queryKey }) => isEntityCollectionQueryKey(queryKey), ...options });
    queryClient.invalidateQueries({ queryKey: entitiesKeys['all'](workspaceId) });
  `,
    ),
  ).toEqual([2, 3, 4, 5]);
});

test("rejects infinite page budgets that are zero, nonfinite, or overwritten", async () => {
  expect(
    await lintSingleRule(
      "query-invalidation-scope",
      `
    infiniteQueryOptions({ maxPages: 0 });
    infiniteQueryOptions({ maxPages: -1 });
    infiniteQueryOptions({ maxPages: Infinity });
    infiniteQueryOptions({ maxPages: 1e999 });
    infiniteQueryOptions({ maxPages: 1.5 });
    infiniteQueryOptions({ maxPages: undefined });
    infiniteQueryOptions({ maxPages: 3, ...options });
    infiniteQueryOptions({ maxPages: 3, maxPages: 0 });
    infiniteQueryOptions({ ...options, maxPages: 3 });
  `,
    ),
  ).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
});
