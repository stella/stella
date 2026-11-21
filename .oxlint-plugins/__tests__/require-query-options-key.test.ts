import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects a bare key and explicit cache data generic", async () => {
  expect(
    await lintSingleRule(
      "require-query-options-key",
      `cache.getQueryData(["tasks"]);
cache.setQueryData<Task[]>(["tasks"], []);`,
    ),
  ).toEqual([1, 2]);
});

test("accepts queryOptions keys through immutable aliases", async () => {
  expect(
    await lintSingleRule(
      "require-query-options-key",
      `import { queryOptions as options } from "@tanstack/react-query";
const taskOptions = options({queryKey:["tasks"], queryFn:load});
const {queryKey: key} = taskOptions;
cache.getQueryData(key);`,
    ),
  ).toEqual([]);
});

test("rejects factories with an untyped return branch", async () => {
  expect(
    await lintSingleRule(
      "require-query-options-key",
      `import {queryOptions} from "@tanstack/react-query";
const options = () => condition ? queryOptions({queryKey:["tasks"],queryFn:load}) : {queryKey:["tasks"]};
cache.getQueryData(options().queryKey);`,
    ),
  ).toEqual([3]);
});

test("accepts imported factory keys and ignores prefix invalidation", async () => {
  expect(
    await lintSingleRule(
      "require-query-options-key",
      `import {taskOptions} from "./queries";
cache.getQueryData(taskOptions().queryKey);
cache.invalidateQueries({queryKey:["tasks"]});`,
    ),
  ).toEqual([]);
});

test("rejects an untagged return in either conditional branch", async () => {
  expect(
    await lintSingleRule(
      "require-query-options-key",
      `import {queryOptions} from "@tanstack/react-query";
const left = () => condition ? {queryKey:["tasks"]} : queryOptions({queryKey:["tasks"],queryFn:load});
const right = () => condition ? queryOptions({queryKey:["tasks"],queryFn:load}) : {queryKey:["tasks"]};
cache.getQueryData(left().queryKey);
cache.getQueryData(right().queryKey);`,
    ),
  ).toEqual([4, 5]);
});

test("requires tagged options on every explicit factory return", async () => {
  expect(
    await lintSingleRule(
      "require-query-options-key",
      `import {queryOptions} from "@tanstack/react-query";
function options(){if(condition) return queryOptions({queryKey:["tasks"],queryFn:load}); return {queryKey:["tasks"]};}
cache.getQueryData(options().queryKey);`,
    ),
  ).toEqual([3]);
});
test("allows a block factory whose explicit returns are all tagged", async () => {
  expect(
    await lintSingleRule(
      "require-query-options-key",
      `import {queryOptions} from "@tanstack/react-query";
function options(){if(condition) return queryOptions({queryKey:["tasks"],queryFn:load}); return queryOptions({queryKey:["other"],queryFn:load});}
cache.getQueryData(options().queryKey);`,
    ),
  ).toEqual([]);
});
test("rejects a mutable key alias even when initialized from tagged options", async () => {
  expect(
    await lintSingleRule(
      "require-query-options-key",
      `import {queryOptions} from "@tanstack/react-query";
const options=queryOptions({queryKey:["tasks"],queryFn:load});
let key=options.queryKey;
cache.getQueryData(key);`,
    ),
  ).toEqual([4]);
});
