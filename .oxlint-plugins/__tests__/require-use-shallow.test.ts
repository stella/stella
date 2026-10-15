import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects fresh object and array selector identities", async () => {
  expect(
    await lintSingleRule(
      "require-use-shallow",
      "useSessionStore(s => ({ user: s.user }));\nuseSessionStore(s => [s.user, s.status]);",
    ),
  ).toEqual([1, 2]);
});

test("rejects fresh returns in selector blocks and bare stores", async () => {
  expect(
    await lintSingleRule(
      "require-use-shallow",
      "useSessionStore(s => { if (s.active) return { user: s.user }; return []; });\nuseStore(store, function(s) { return [s.user]; });",
    ),
  ).toEqual([1, 2]);
});

test("accepts primitive selectors and complete store access", async () => {
  expect(
    await lintSingleRule(
      "require-use-shallow",
      "useSessionStore(s => s.user);\nuseSessionStore();",
    ),
  ).toEqual([]);
});

test("accepts aliased shallow selectors", async () => {
  expect(
    await lintSingleRule(
      "require-use-shallow",
      'import { useShallow as shallow } from "zustand/react/shallow";\nuseSessionStore(shallow(s => ({ user: s.user })));',
    ),
  ).toEqual([]);
});

test("accepts the other documented shallow entry point", async () => {
  expect(
    await lintSingleRule(
      "require-use-shallow",
      'import { useShallow } from "zustand/shallow";\nuseStore(store, useShallow(s => [s.user]));',
    ),
  ).toEqual([]);
});
