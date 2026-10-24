import "@/api/register-schema-formats";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { Value } from "@sinclair/typebox/value";
import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import ts from "typescript6";
import * as v from "valibot";

import { isApiDate, vApiDate } from "@stll/api-contract/api-date";

import { toJsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";

const dateSchema = t.String({ format: "date" });
const dateTimeSchema = t.String({ format: "date-time" });

const API_SOURCE_ROOT = `${import.meta.dir}/../..`;
const API_CONTRACT_SOURCE_ROOT = `${import.meta.dir}/../../../../../packages/api-contract/src`;
const DATE_SCHEMA_SOURCES = [
  { root: API_SOURCE_ROOT, canonicalOwner: null },
  { root: API_CONTRACT_SOURCE_ROOT, canonicalOwner: "api-date.ts" },
] as const;
// Development helpers and one-off scripts never take a request or write a row.
const OUTSIDE_RUNTIME = /^(?:dev|scripts|tests)\//u;

const callsValibotIsoDate = (source: string): boolean => {
  const file = ts.createSourceFile(
    "schema.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const namespaces = new Set<string>();
  const named = new Set<string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "valibot" ||
      statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (
          !binding.isTypeOnly &&
          (binding.propertyName ?? binding.name).text === "isoDate"
        ) {
          named.add(binding.name.text);
        }
      }
    }
  }
  const unwrap = (node: ts.Expression): ts.Expression => {
    let expression = node;
    while (ts.isParenthesizedExpression(expression)) {
      expression = expression.expression;
    }
    return expression;
  };
  const visit = (node: ts.Node): boolean => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee) && named.has(callee.text)) {
        return true;
      }
      if (
        ts.isPropertyAccessExpression(callee) ||
        ts.isElementAccessExpression(callee)
      ) {
        const owner = unwrap(callee.expression);
        let property: string | null = null;
        if (ts.isPropertyAccessExpression(callee)) {
          property = callee.name.text;
        } else if (ts.isStringLiteral(callee.argumentExpression)) {
          property = callee.argumentExpression.text;
        }
        if (
          ts.isIdentifier(owner) &&
          namespaces.has(owner.text) &&
          property === "isoDate"
        ) {
          return true;
        }
      }
    }
    return (
      ts.forEachChild(node, (child) => (visit(child) ? true : undefined)) ??
      false
    );
  };
  return visit(file);
};

describe("API calendar date boundaries", () => {
  test("accepts exactly existing CE calendar days across month and leap-century boundaries", () => {
    const compiled = TypeCompiler.Compile(dateSchema);
    // Include the 0..99 Date constructor trap and Gregorian century exceptions.
    for (const year of [
      0, 1, 4, 99, 100, 399, 400, 1600, 1700, 1900, 2000, 2024, 2026, 2028,
      9999,
    ]) {
      for (let month = 0; month <= 13; month += 1) {
        for (let day = 0; day <= 32; day += 1) {
          const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          // Independent oracle: JavaScript normalizes nonexistent days, so only
          // a round trip with unchanged components represents a real date.
          const normalized = new Date(0);
          normalized.setUTCFullYear(year, month - 1, day);
          const expected =
            year > 0 &&
            normalized.getUTCFullYear() === year &&
            normalized.getUTCMonth() === month - 1 &&
            normalized.getUTCDate() === day;
          expect(isApiDate(value)).toBe(expected);
          expect(compiled.Check(value)).toBe(expected);
          expect(Value.Check(dateSchema, value)).toBe(expected);
          expect(v.is(vApiDate, value)).toBe(expected);
        }
      }
    }
  });

  test.each([
    "2026-2-01",
    "2026-02-1",
    "2026/02/01",
    "01/02/2026",
    "2026-02-01T00:00:00Z",
    "+010000-01-01",
    "-0001-01-01",
    " 2026-02-01",
    "2026-02-01\n",
    '"2026-02-01"',
    "",
  ])("rejects noncanonical calendar date %j", (value) => {
    expect(Value.Check(dateSchema, value)).toBe(false);
  });

  test.each([true, false])(
    "rejects invalid body and query dates before handlers (aot=%s)",
    async (aot) => {
      let calls = 0;
      const app = new Elysia({ aot })
        .patch(
          "/task",
          ({ body }) => {
            calls += 1;
            return body;
          },
          {
            body: t.Object({ dueDate: t.Optional(t.Nullable(dateSchema)) }),
          },
        )
        .get(
          "/overview",
          ({ query }) => {
            calls += 1;
            return query;
          },
          {
            query: t.Object({ agendaFrom: t.Optional(dateSchema) }),
          },
        );

      for (const value of [
        "2026-02-30",
        "2026-02-29",
        "1900-02-29",
        "2026-04-31",
        "0000-01-01",
        "2026-13-01",
        "2026-02-01T00:00:00Z",
      ]) {
        const bodyResponse = await app.handle(
          new Request("http://localhost/task", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ dueDate: value }),
          }),
        );
        expect(bodyResponse.status).toBe(422);
        const queryResponse = await app.handle(
          new Request(
            `http://localhost/overview?agendaFrom=${encodeURIComponent(value)}`,
          ),
        );
        expect(queryResponse.status).toBe(422);
      }
      expect(calls).toBe(0);

      for (const dueDate of [
        "0001-01-01",
        "0099-12-31",
        "2000-02-29",
        "2028-02-29",
        "9999-12-31",
        "2011-12-30",
        null,
        undefined,
      ]) {
        const response = await app.handle(
          new Request("http://localhost/task", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ dueDate }),
          }),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(
          dueDate === undefined ? {} : { dueDate },
        );
      }
      const response = await app.handle(
        new Request("http://localhost/overview?agendaFrom=2028-02-29"),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ agendaFrom: "2028-02-29" });
      expect(calls).toBe(9);
    },
  );

  test("publishes the Valibot date as a plain date format", () => {
    expect(toJsonSchema(vApiDate)).toMatchObject({
      type: "string",
      format: "date",
    });
    expect(JSON.stringify(toJsonSchema(vApiDate))).not.toContain("pattern");
  });
});

describe("API date-time storage boundaries", () => {
  test.each([
    "2026-10-23T10:00:00Z",
    "0001-01-01T00:00:00Z",
    "9999-12-31T23:59:59Z",
  ])("accepts the storable instant %s", (value) => {
    expect(Value.Check(dateTimeSchema, value)).toBe(true);
  });

  test.each([
    '"2026-10-23T10:00:00Z"',
    "0000-01-01T00:00:00Z",
    // A positive offset moves the instant back into UTC year 0.
    "0001-01-01T00:00:00+01:00",
    // A negative offset moves the instant forward into UTC year 10000.
    "9999-12-31T23:59:59-23:59",
  ])("rejects the unstorable instant %s", (value) => {
    expect(Value.Check(dateTimeSchema, value)).toBe(false);
  });
});

test.each([
  'import * as v from "valibot"; v.isoDate();',
  'import * as v from "valibot"; v.isoDate("Expected a date");',
  'import { isoDate } from "valibot"; isoDate("Expected a date");',
  'import { isoDate as day } from "valibot"; day("Expected a date");',
  'import * as dates from "valibot"; (dates["isoDate"])("Expected a date");',
])(
  "finds runtime Valibot date calls regardless of import spelling or arguments: %s",
  (source) => {
    expect(callsValibotIsoDate(source)).toBe(true);
  },
);

test.each([
  'import * as v from "another-library"; v.isoDate();',
  'import { isoDate as day } from "another-library"; day();',
  'const isoDate = () => "2026-10-23"; isoDate();',
  'import * as v from "valibot"; const example = "v.isoDate()";',
  'import type * as v from "valibot"; type DateSchema = v.IsoDateAction<string, undefined>;',
])("ignores sources without a runtime Valibot date call: %s", (source) => {
  expect(callsValibotIsoDate(source)).toBe(false);
});

test("every Valibot date schema checks the calendar day", async () => {
  const loose: string[] = [];
  for (const { root, canonicalOwner } of DATE_SCHEMA_SOURCES) {
    for (const filename of new Glob("**/*.ts").scanSync(root)) {
      if (
        filename === canonicalOwner ||
        filename.endsWith(".test.ts") ||
        OUTSIDE_RUNTIME.test(filename)
      ) {
        continue;
      }
      const source = await Bun.file(`${root}/${filename}`).text();
      if (callsValibotIsoDate(source)) {
        loose.push(`${root}/${filename}`);
      }
    }
  }
  // `isoDate()` alone passes impossible days and year 0000; use `vApiDate`.
  expect(loose).toEqual([]);
});
