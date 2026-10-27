import { expect, test } from "bun:test";

import {
  isObjectLiteralProperty,
  isSideEffectImport,
  parseSource,
  Visitor,
  walk,
} from "./syntax-tree";

test("classifies side-effect imports independently of syntax trivia", () => {
  for (const [text, expected] of [
    ['import "module";', true],
    ['import /* 注釈 */\n// registration\n"module";', true],
    ['import {} from "module";', false],
    ['import /* 注釈 */ {} from "module";', false],
    ['import value from "module";', false],
    ['import type { Value } from "module";', false],
  ] as const) {
    const parsed = parseSource("fixture.ts", text);
    const statement = parsed.program.body[0];
    expect(statement?.type).toBe("ImportDeclaration");
    if (statement?.type === "ImportDeclaration") {
      expect(isSideEffectImport(statement, parsed)).toBe(expected);
    }
  }
});

test("walks in source order with ancestors and can skip a subtree", () => {
  const parsed = parseSource(
    "fixture.ts",
    "outer(inner(1), () => hidden(2));\nlast();\n",
  );
  const calls: string[] = [];
  walk(parsed.program, (node, ancestors) => {
    if (node.type === "ArrowFunctionExpression") {
      return "skip-children";
    }
    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      calls.push(
        `${node.callee.name}<${ancestors.map(({ type }) => type).join(">")}`,
      );
    }
    return undefined;
  });
  expect(calls).toEqual([
    "outer<Program>ExpressionStatement",
    "inner<Program>ExpressionStatement>CallExpression",
    "last<Program>ExpressionStatement",
  ]);
});

test("locates nodes by UTF-16 offset across non-ASCII lines", () => {
  const source = 'const ž = "čšř😀";\n\n  export const b = 1;\n';
  const parsed = parseSource("fixture.ts", source);
  const names: string[] = [];
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type === "Identifier") {
        names.push(node.id.name);
        expect(parsed.locate(node.id.start)).toEqual(
          node.id.name === "b"
            ? { column: 16, line: 3 }
            : { column: 7, line: 1 },
        );
      }
    },
  }).visit(parsed.program);
  expect(names).toEqual(["ž", "b"]);
  expect(parsed.locate(source.length)).toEqual({ column: 1, line: 4 });
});

test("parses TypeScript-only syntax and keeps comments", () => {
  const parsed = parseSource(
    "fixture.tsx",
    "// lead\nconst t = { a: 'x' } satisfies object;\nexport const C = <div>{t.a}</div>; /* tail */\n",
  );
  expect(parsed.comments.map(({ value }) => value.trim())).toEqual([
    "lead",
    "tail",
  ]);
  expect(parsed.module.staticExports).toHaveLength(1);
});

test("tells object literal entries from destructuring entries", () => {
  const parsed = parseSource(
    "fixture.ts",
    "const { a, b: c = 1 } = { a: 1, b, d() {} };\n({ e } = f);\n",
  );
  const entries: string[] = [];
  walk(parsed.program, (node, ancestors) => {
    if (node.type === "Property" && node.key.type === "Identifier") {
      entries.push(
        `${node.key.name}:${isObjectLiteralProperty(node, ancestors.at(-1))}`,
      );
    }
    return undefined;
  });
  expect(entries).toEqual([
    "a:false",
    "b:false",
    "a:true",
    "b:true",
    "d:true",
    "e:false",
  ]);
});

test("refuses a file that does not parse", () => {
  expect(() => parseSource("broken.ts", "const = ;")).toThrow(
    "broken.ts does not parse",
  );
});
