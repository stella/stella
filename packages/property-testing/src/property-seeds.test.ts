import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type Node, parseSync, visitorKeys } from "oxc-parser";

import { PropertyTestConfigError } from "./index";
import { parsePinnedSeeds, readPinnedSeeds, REPO_ROOT } from "./pinned-seeds";

const propertyIds = (file: string, source: string): Set<string> => {
  const parsed = parseSync(file, source);
  const errors = parsed.errors.filter((error) => {
    const severity: string = error.severity;
    return severity === "Error";
  });
  if (errors.length > 0) {
    throw new PropertyTestConfigError(
      `${file} does not parse: ${errors.map(({ message }) => message).join("; ")}`,
    );
  }
  const assertions = new Set<string>();
  const tests = new Set<string>();
  for (const statement of parsed.program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    for (const binding of statement.specifiers) {
      if (binding.type !== "ImportSpecifier") {
        continue;
      }
      const name =
        binding.imported.type === "Identifier"
          ? binding.imported.name
          : binding.imported.value;
      if (
        statement.source.value === "@stll/property-testing" &&
        name === "assertProperty"
      ) {
        assertions.add(binding.local.name);
      }
      if (
        statement.source.value === "bun:test" &&
        (name === "test" || name === "it")
      ) {
        tests.add(binding.local.name);
      }
    }
  }
  const ids = new Set<string>();
  const stringValue = (node: Node): string | undefined => {
    if (node.type === "Literal" && typeof node.value === "string") {
      return node.value;
    }
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
      return node.quasis.at(0)?.value.cooked ?? undefined;
    }
    return undefined;
  };
  const isNode = (value: unknown): value is Node =>
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string";

  const visit = (node: Node, title?: string): void => {
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const argument = node.arguments.at(0);
      if (callee.type === "Identifier" && assertions.has(callee.name)) {
        if (
          argument === undefined ||
          stringValue(argument) === undefined ||
          stringValue(argument) !== title
        ) {
          throw new PropertyTestConfigError(
            `${file}: property id must match its enclosing test title`,
          );
        }
        const id = stringValue(argument);
        if (id === undefined) {
          throw new PropertyTestConfigError(
            `${file}: property id must match its enclosing test title`,
          );
        }
        if (ids.has(id)) {
          throw new PropertyTestConfigError(
            `${file}::${id}: duplicate property id`,
          );
        }
        ids.add(id);
      }
      const testCallee =
        callee.type === "MemberExpression" && !callee.computed
          ? callee.object
          : callee;
      if (testCallee.type === "Identifier" && tests.has(testCallee.name)) {
        const callback = node.arguments.at(1);
        if (
          callback !== undefined &&
          (callback.type === "ArrowFunctionExpression" ||
            callback.type === "FunctionExpression")
        ) {
          visit(
            callback.body,
            argument === undefined ? undefined : stringValue(argument),
          );
          return;
        }
      }
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const child: unknown = Reflect.get(node, key);
      if (Array.isArray(child)) {
        for (const item of child) {
          if (isNode(item)) {
            visit(item, title);
          }
        }
      } else if (isNode(child)) {
        visit(child, title);
      }
    }
  };
  visit(parsed.program);
  return ids;
};

const fixture = (body: string): string => `
  import { test, it as example } from "bun:test";
  import { assertProperty as check } from "@stll/property-testing";
  ${body}
`;

test("property ids belong to their enclosing test and are unique within a file", () => {
  expect([
    ...propertyIds(
      "fixture.test.ts",
      fixture(`
    test("alpha", () => { check("alpha", property); });
    example("beta", () => { check("beta", property); });
  `),
    ),
  ]).toEqual(["alpha", "beta"]);
  expect(() =>
    propertyIds(
      "fixture.test.ts",
      fixture(`
    test("alpha", () => { check("beta", property); });
    test("beta", () => {});
  `),
    ),
  ).toThrow("property id must match its enclosing test title");
  expect(() =>
    propertyIds(
      "fixture.test.ts",
      fixture(`
    test("alpha", () => { check("alpha", property); });
    test("alpha", () => { check("alpha", property); });
  `),
    ),
  ).toThrow("duplicate property id");
});

test("every property id matches its enclosing test across workspaces", async () => {
  for await (const file of new Bun.Glob(
    "{apps,packages}/**/*.test.{ts,tsx}",
  ).scan({ cwd: REPO_ROOT })) {
    // This package deliberately exercises invalid assertions and parser fixtures.
    if (
      file.includes("node_modules") ||
      file.startsWith("packages/property-testing/")
    ) {
      continue;
    }
    const source = readFileSync(path.join(REPO_ROOT, file), "utf-8");
    if (source.includes("assertProperty")) {
      propertyIds(file, source);
    }
  }
});

test("every pinned seed names an existing test using its explicit property id", () => {
  for (const [key, entries] of Object.entries(readPinnedSeeds().unwrap())) {
    const separator = key.lastIndexOf("::");
    expect(separator).toBeGreaterThan(0);
    const file = key.slice(0, separator);
    const id = key.slice(separator + 2);
    expect(id.length).toBeGreaterThan(0);
    expect(file).toMatch(/^(apps|packages|scripts)\/.+\.test\.tsx?$/u);
    expect(file.split("/")).not.toContain("..");
    const source = readFileSync(path.join(REPO_ROOT, file), "utf-8");
    expect(propertyIds(file, source).has(id)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  }
});

test("rejects malformed paths and missing pin metadata while ignoring comment keys", () => {
  const entry = {
    seed: 123,
    path: "0:1:2",
    note: "Regression coverage",
    date: "2026-09-30",
  };
  expect(
    parsePinnedSeeds({ $comment: "ignored", "file::id": [entry] }).unwrap(),
  ).toEqual({ "file::id": [entry] });
  for (const invalid of [
    { ...entry, path: "" },
    { ...entry, path: "0:x" },
    { ...entry, note: "" },
    { ...entry, date: undefined },
    { ...entry, seed: 1.5 },
  ]) {
    const result = parsePinnedSeeds({ "file::id": [invalid] });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(PropertyTestConfigError);
      expect(result.error.message).toBe(
        "file::id: invalid seed, path, note or date",
      );
    }
  }
});

test("returns configuration errors for invalid registry and seed-list shapes", () => {
  for (const [value, message] of [
    [null, "Property seeds must be an object"],
    [[], "Property seeds must be an object"],
    [{ "file::id": {} }, "file::id: expected an array of pinned seeds"],
  ] as const) {
    const result = parsePinnedSeeds(value);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(PropertyTestConfigError);
      expect(result.error.message).toBe(message);
    }
  }
});

test("rejects property seed keys outside canonical order", () => {
  const entry = {
    seed: 123,
    note: "Regression coverage",
    date: "2026-09-30",
  };
  const result = parsePinnedSeeds({
    "z.test.ts::z": [entry],
    "a.test.ts::a": [entry],
  });

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toBe(
      "Property seed keys must be sorted and duplicate-free",
    );
  }
});
