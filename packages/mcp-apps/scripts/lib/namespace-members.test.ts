import { expect, test } from "bun:test";

import { parseSource } from "@stll/scripts/src/syntax-tree";

import { namespaceMembers } from "./namespace-members";

const membersOf = (source: string) => {
  const members = namespaceMembers(
    parseSource("app.js", `import * as v from "lib";\n${source}`).program,
    new Set(["v"]),
  ).get("v");
  return members === undefined ? undefined : [...members].toSorted();
};

test("static and string-keyed reads name the members", () => {
  expect(membersOf('v.object({ a: v.string() }); v["parse"](x);')).toEqual([
    "object",
    "parse",
    "string",
  ]);
});

test.each([
  ["passed on", "use(v);"],
  ["spread", "({ ...v });"],
  ["read with a computed key", "v[key];"],
  ["shorthand", "({ v });"],
  ["assigned", "const copy = v;"],
])("a namespace %s is used whole", (_, source) => {
  expect(membersOf(source)).toBeUndefined();
});

test.each([
  ["a parameter", "const f = (v) => v.length; v.a;"],
  ["a destructured parameter", "function f({ v }) { return use(v); } v.a;"],
  [
    "a var anywhere in the function",
    "function f() { use(v); var v = 1; } v.a;",
  ],
  ["a block declaration", "{ const v = 1; use(v); } v.a;"],
  ["a catch parameter", "try {} catch (v) { use(v); } v.a;"],
  ["a loop declaration", "for (const v of list) use(v); v.a;"],
  ["a function's own name", "(function v() { use(v); }); v.a;"],
  ["a class's own name", "(class v { m() { use(v); } }); v.a;"],
])("an identifier declared by %s is not the namespace", (_, source) => {
  expect(membersOf(source)).toEqual(["a"]);
});

test("a function's body vars do not shadow its parameter defaults", () => {
  expect(membersOf("function f(x = use(v)) { var v; }")).toBeUndefined();
});

test("property keys, labels and members of other objects are names only", () => {
  expect(
    membersOf("({ v: 1 }); o.v; class C { v() {} } v: for (;;) break v; v.a;"),
  ).toEqual(["a"]);
});
