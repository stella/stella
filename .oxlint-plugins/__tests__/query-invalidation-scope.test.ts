import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "query-invalidation-scope";
const OPTIONS = {
  sourcePath: "apps/web/src/lib/workspaces/mutations/case.ts",
  cwd: "scratch",
} as const;
const IMPORTS = `import { entitiesKeys, isEntityCollectionQueryKey } from "@/lib/workspaces/queries/entities.logic";`;

const lint = async (body: string) =>
  await lintSingleRule(RULE, `${IMPORTS}\n${body}`, OPTIONS);

test("rejects broad all-key invalidation in mutation callbacks", async () => {
  expect(
    await lint(
      "useMutation({ onSuccess: () => queryClient.invalidateQueries({ queryKey: entitiesKeys.all(workspaceId) }) });",
    ),
  ).toEqual([2]);
});

test("accepts narrow mutation invalidation", async () => {
  expect(
    await lint(
      "useMutation({ onSettled: () => queryClient.invalidateQueries({ queryKey: entitiesKeys.detail(workspaceId, entityId) }) });",
    ),
  ).toEqual([]);
});

test("rejects entity-root invalidation extracted into a helper", async () => {
  expect(
    await lint(`export const invalidateEntityQueries = () => queryClient.invalidateQueries({
  queryKey: entitiesKeys.all(workspaceId),
});`),
  ).toEqual([2]);
});

test("accepts collection predicates and independently targeted detail invalidation", async () => {
  expect(
    await lint(`queryClient.invalidateQueries({ queryKey: entitiesKeys.all(workspaceId), predicate: ({ queryKey }) => isEntityCollectionQueryKey(queryKey) });
queryClient.invalidateQueries({ queryKey: entitiesKeys.all(workspaceId), predicate: ({ queryKey: key }) => isEntityCollectionQueryKey(key) });
queryClient.invalidateQueries({ queryKey: entitiesKeys.detail(workspaceId, entityId) });
queryClient.invalidateQueries({ queryKey: inboxKeys.all(workspaceId) });
queryClient.invalidateQueries({ queryKey: entityViewKeys.all(workspaceId) });`),
  ).toEqual([]);
});

test("rejects predicates that do not constrain the invalidated query", async () => {
  expect(
    await lint(`queryClient.invalidateQueries({ queryKey: entitiesKeys.all(workspaceId), predicate: () => true });
queryClient.invalidateQueries({ queryKey: entitiesKeys.all(workspaceId), predicate: ({ queryKey }) => isEntityCollectionQueryKey(otherKey) });
queryClient.invalidateQueries({ queryKey: entitiesKeys.all(workspaceId), predicate: ({ queryKey }) => isEntityCollectionQueryKey(queryKey), ...options });
queryClient.invalidateQueries({ queryKey: entitiesKeys['all'](workspaceId) });`),
  ).toEqual([2, 3, 4, 5]);
});

test("follows aliases of the owned key factory and predicate", async () => {
  expect(
    await lint(`const keys = entitiesKeys;
const isCollection = isEntityCollectionQueryKey;
queryClient.invalidateQueries({ queryKey: keys.all(workspaceId) });
queryClient.invalidateQueries({ queryKey: keys.all(workspaceId), predicate: ({ queryKey }) => isCollection(queryKey) });`),
  ).toEqual([4]);
});

test("rejects a same-named predicate that is not the owned one", async () => {
  expect(
    await lint(`const check = (isEntityCollectionQueryKey) =>
  queryClient.invalidateQueries({ queryKey: entitiesKeys.all(workspaceId), predicate: ({ queryKey }) => isEntityCollectionQueryKey(queryKey) });`),
  ).toEqual([3]);
});

test("ignores same-named key factories from other modules", async () => {
  expect(
    await lintSingleRule(
      RULE,
      `import { entitiesKeys } from "@/lib/other-keys";
queryClient.invalidateQueries({ queryKey: entitiesKeys.all(workspaceId) });`,
      OPTIONS,
    ),
  ).toEqual([]);
});
