import { expect, test } from "bun:test";

import {
  parseSource,
  staticPropertyName,
  walk,
} from "@stll/scripts/src/syntax-tree";

const violations = (filename: string, source: string) => {
  const parsed = parseSource(filename, source);
  const found: string[] = [];
  walk(parsed.program, (node, ancestors) => {
    if (
      node.type === "ImportDeclaration" &&
      node.source.value === "expo-secure-store" &&
      filename !== "connection/platform.ts"
    ) {
      found.push("keychain adapter owner");
    }
    if (
      filename === "connection/platform.ts" &&
      node.type === "CallExpression" &&
      node.callee.type === "Identifier"
    ) {
      const operation = node.callee.name;
      if (operation !== "setItemAsync" && operation !== "deleteItemAsync") {
        return;
      }
      const property = ancestors.findLast(
        (parent) => parent.type === "Property",
      );
      const method =
        property?.type === "Property"
          ? staticPropertyName(property)
          : undefined;
      const queuedAdapter = ancestors.some(
        (parent) =>
          parent.type === "CallExpression" &&
          parent.callee.type === "Identifier" &&
          parent.callee.name === "createSessionStore",
      );
      if (
        !queuedAdapter ||
        (operation === "setItemAsync"
          ? method !== "write" && method !== "prepareClear"
          : method !== "clear")
      ) {
        found.push("keychain mutation adapter");
      }
    }
    if (
      filename === "connection/session.ts" &&
      node.type === "MemberExpression" &&
      node.object.type === "Identifier" &&
      node.object.name === "persistence"
    ) {
      const method = staticPropertyName({
        computed: node.computed,
        key: node.property,
      });
      if (method === "read") {
        return;
      }
      if (
        !ancestors.some(
          (parent) =>
            parent.type === "CallExpression" &&
            parent.callee.type === "Identifier" &&
            parent.callee.name === "enqueue",
        )
      ) {
        found.push("serialized credential mutation");
      }
    }
    if (
      filename === "connection/session-provider.tsx" &&
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "setState"
    ) {
      const updater = node.arguments.at(0);
      if (
        updater?.type !== "ArrowFunctionExpression" ||
        updater.body.type !== "LogicalExpression" ||
        updater.body.operator !== "??" ||
        updater.body.left.type !== "CallExpression" ||
        updater.body.left.callee.type !== "MemberExpression" ||
        updater.body.left.callee.object.type !== "Identifier" ||
        updater.body.left.callee.object.name !== "deviceSessionStore" ||
        staticPropertyName({
          computed: updater.body.left.callee.computed,
          key: updater.body.left.callee.property,
        }) !== "commit"
      ) {
        found.push("generation-owned state commit");
      }
    }
  });
  return found;
};

test("mobile credential mutations and state commits have one owner", async () => {
  const root = new URL("../", import.meta.url).pathname;
  for await (const filename of new Bun.Glob("**/*.{ts,tsx}").scan(root)) {
    if (filename.endsWith(".test.ts")) {
      continue;
    }
    expect(
      violations(filename, await Bun.file(`${root}${filename}`).text()),
      filename,
    ).toEqual([]);
  }
});

test("the ownership guard rejects mutations outside their owners", () => {
  expect(
    violations("other.ts", 'import * as keychain from "expo-secure-store";'),
  ).toEqual(["keychain adapter owner"]);
  expect(
    violations(
      "connection/platform.ts",
      "createSessionStore({ read: async () => { await deleteItemAsync(key); } });",
    ),
  ).toEqual(["keychain mutation adapter"]);
  expect(
    violations(
      "connection/session.ts",
      "const read = async () => await persistence.clear();",
    ),
  ).toEqual(["serialized credential mutation"]);
  expect(
    violations(
      "connection/session-provider.tsx",
      'setState({ status: "signed-out" });',
    ),
  ).toEqual(["generation-owned state commit"]);
});
