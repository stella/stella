import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects literal cache keys at positional and filter call sites", async () => {
  expect(
    await lintSingleRule(
      "require-query-key-factory",
      'client.invalidateQueries({ queryKey: ["contacts", orgId] });\nclient.setQueryData(["chat", orgId], next);\nclient.removeQueries({ queryKey: ["chat"] });\nclient.cancelQueries({ queryKey: ["chat"] });',
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("resolves function-local key and filters literals to their declaration lines", async () => {
  expect(
    await lintSingleRule(
      "require-query-key-factory",
      'function refresh() {\nconst key = ["chat", orgId];\nconst options = { queryKey: ["contacts", orgId] };\nclient.setQueryData(key, next);\nclient.invalidateQueries(options);\n}',
    ),
  ).toEqual([2, 3]);
});

test("rejects inline positional predicates including negative at offsets", async () => {
  expect(
    await lintSingleRule(
      "require-query-key-factory",
      'client.removeQueries({ predicate: q => q.queryKey.at(0) === "chat" });\nclient.invalidateQueries({ predicate: q => q.queryKey[1] !== orgId });\nclient.cancelQueries({ predicate: q => "thread" === q.queryKey.at(-1) });',
    ),
  ).toEqual([1, 2, 3]);
});

test("accepts factories named predicate owners module constants and blanket refreshes", async () => {
  expect(
    await lintSingleRule(
      "require-query-key-factory",
      'const sharedKey = ["chat"];\nclient.invalidateQueries({ queryKey: contactsKeys.list(orgId) });\nclient.setQueryData(options(input).queryKey, next);\nclient.removeQueries({ predicate: q => matchesChatThread(q.queryKey, ref) });\nclient.setQueryData(sharedKey, next);\nclient.invalidateQueries();',
    ),
  ).toEqual([]);
});

test("reports local literal aliases while leaving mutable bindings unresolved", async () => {
  expect(
    await lintSingleRule(
      "require-query-key-factory",
      [
        "function refresh() {",
        'let key = ["chat"];',
        'const literal = ["chat"];',
        "const alias = literal;",
        'let filters = { queryKey: ["chat"] };',
        "client.setQueryData(key, next);",
        "client.setQueryData(alias, next);",
        "client.invalidateQueries(filters);",
        "}",
      ].join("\n"),
    ),
  ).toEqual([3]);
});

test("follows local key and filter aliases to literal provenance", async () => {
  expect(
    await lintSingleRule(
      "require-query-key-factory",
      [
        "function refresh() {",
        'const key = ["chat"];',
        "const alias = key;",
        "const finalAlias = alias;",
        "const filters = { queryKey: finalAlias };",
        "const options = filters;",
        "client.setQueryData(finalAlias, next);",
        "client.invalidateQueries(options);",
        "}",
      ].join("\n"),
    ),
  ).toEqual([2, 2]);
});
