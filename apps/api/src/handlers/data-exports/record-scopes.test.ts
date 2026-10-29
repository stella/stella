import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { getTableColumns, is } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

import * as schema from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

import { dataExportRecordScope } from "./record-scopes";

const parse = (fileName: string): ts.SourceFile => {
  const sourcePath = path.join(import.meta.dir, fileName);
  return ts.createSourceFile(
    sourcePath,
    readFileSync(sourcePath, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );
};

const recordsSource = parse("records.ts");
const exportSource = parse("export-source.ts");

const exportedRecordTables = (): Map<string, PgTable> => {
  const identifiers = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isSatisfiesExpression(node.initializer) &&
      ts.isTypeReferenceNode(node.initializer.type) &&
      ts.isIdentifier(node.initializer.type.typeName) &&
      node.initializer.type.typeName.text === "ColumnMap"
    ) {
      const typeArguments = node.initializer.type.typeArguments;
      const tableType = typeArguments?.at(0);
      if (
        tableType !== undefined &&
        ts.isTypeQueryNode(tableType) &&
        ts.isIdentifier(tableType.exprName)
      ) {
        identifiers.add(tableType.exprName.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(recordsSource);

  const schemaExports = new Map(Object.entries(schema));
  const tables = new Map<string, PgTable>();
  for (const identifier of identifiers) {
    const value = schemaExports.get(identifier);
    if (value === undefined || !is(value, PgTable)) {
      return panic(
        `Exported record table is missing from schema: ${identifier}`,
      );
    }
    tables.set(identifier, value);
  }
  return tables;
};

const isIdentifierArgument = (
  argument: ts.Expression | undefined,
  text?: string,
): argument is ts.Identifier =>
  argument !== undefined &&
  ts.isIdentifier(argument) &&
  (text === undefined || argument.text === text);

const isNullArgument = (argument: ts.Expression | undefined) =>
  argument !== undefined && argument.kind === ts.SyntaxKind.NullKeyword;

const callsNamed = (source: ts.SourceFile, name: string) =>
  allCallsIn(source).filter(
    (call) => ts.isIdentifier(call.expression) && call.expression.text === name,
  );

const hasTableFromCall = (node: ts.Node, tableName: string): boolean =>
  allCallsIn(node).some(
    (call) =>
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === "from" &&
      isIdentifierArgument(call.arguments.at(0), tableName),
  );

const allCallsIn = (node: ts.Node): ts.CallExpression[] => {
  const calls: ts.CallExpression[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isCallExpression(child)) {
      calls.push(child);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return calls;
};

const enclosingFunctionBindings = (node: ts.Node) => {
  const bindings: { name: string; parameters: string[] }[] = [];
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.initializer !== undefined &&
      (ts.isArrowFunction(current.initializer) ||
        ts.isFunctionExpression(current.initializer))
    ) {
      bindings.push({
        name: current.name.text,
        parameters: current.initializer.parameters.map((parameter) =>
          ts.isIdentifier(parameter.name) ? parameter.name.text : "",
        ),
      });
    }
    current = current.parent;
  }
  return bindings;
};

const scopeNames = (calls: readonly ts.CallExpression[], index: number) => {
  const scopes = new Set<"null-matter" | "matter">();
  for (const call of calls) {
    const argument = call.arguments.at(index);
    if (isNullArgument(argument)) {
      scopes.add("null-matter");
    } else if (isIdentifierArgument(argument)) {
      scopes.add("matter");
    }
  }
  return scopes;
};

const scopedQueryCalls = (tableName: string) => {
  const candidates: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "dataExportRecordScope" &&
      isIdentifierArgument(node.arguments.at(0), tableName)
    ) {
      let ancestor: ts.Node | undefined = node.parent;
      while (ancestor !== undefined && !ts.isSourceFile(ancestor)) {
        if (
          ts.isVariableDeclaration(ancestor) &&
          ancestor.initializer !== undefined &&
          hasTableFromCall(ancestor.initializer, tableName)
        ) {
          candidates.push(node);
          break;
        }
        ancestor = ancestor.parent;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(exportSource);
  return candidates;
};

const scopesFromReaderQueries = (tableName: string) => {
  const scopes = new Set<"null-matter" | "matter">();
  for (const helperCall of scopedQueryCalls(tableName)) {
    const scopeArgument = helperCall.arguments.at(1);
    if (isNullArgument(scopeArgument)) {
      scopes.add("null-matter");
      continue;
    }
    if (!isIdentifierArgument(scopeArgument)) {
      continue;
    }
    scopes.add("matter");

    const bindings = enclosingFunctionBindings(helperCall);
    for (const binding of bindings) {
      const parameterIndex = binding.parameters.indexOf(scopeArgument.text);
      if (parameterIndex === -1) {
        continue;
      }
      for (const scope of scopeNames(
        callsNamed(exportSource, binding.name),
        parameterIndex,
      )) {
        scopes.add(scope);
      }
    }
  }
  return scopes;
};

const nullableWorkspaceRecordTables = () =>
  [...exportedRecordTables()].flatMap(([name, table]) => {
    const workspaceColumn = Object.values(getTableColumns(table)).find(
      (column) => column.name === "workspace_id",
    );
    return workspaceColumn === undefined || workspaceColumn.notNull
      ? []
      : [{ name, table }];
  });

const columnSql = (table: PgTable, workspaceId: SafeId<"workspace"> | null) =>
  new PgDialect().sqlToQuery(dataExportRecordScope(table, workspaceId));

describe("data export record scope coverage", () => {
  test("every nullable exported workspace table is read in both scopes", () => {
    const candidates = nullableWorkspaceRecordTables();
    const scopesByTable = new Map<string, ReadonlySet<string>>();
    for (const { name } of candidates) {
      scopesByTable.set(name, scopesFromReaderQueries(name));
    }

    expect(candidates.length).toBeGreaterThan(0);
    for (const { name } of candidates) {
      const scopes = scopesByTable.get(name);
      expect(scopes, `${name} reader scope`).toBeDefined();
      expect(
        scopes === undefined ? undefined : [...scopes].toSorted(),
        `${name} must read every workspace scope`,
      ).toEqual(["matter", "null-matter"]);
    }
  });

  test("invoice children inherit both scopes through the invoice foreign key", () => {
    const invoiceLines = schema.invoiceLines;
    const parent = schema.invoices;
    const source = exportSource.text;
    expect(source).toContain("readInvoiceRecords(reader, null)");
    expect(source).toContain("readInvoiceRecords(reader, workspaceId)");
    expect(source).toContain("inArray(invoiceLines.invoiceId, invoiceIds)");
    expect(source).not.toContain("invoiceLines.workspaceId");
    expect(
      getTableConfig(invoiceLines).foreignKeys.some(
        (foreignKey) =>
          getTableConfig(foreignKey.reference().foreignTable).name ===
          getTableConfig(parent).name,
      ),
    ).toBe(true);
  });

  test("the shared predicate reflects nullable and required workspace parents", () => {
    const nullableTable = schema.invoices;
    const requiredTable = schema.workspaceContacts;
    const nullMatter = columnSql(nullableTable, null);
    expect(nullMatter.sql).toContain('"workspace_id" is null');
    const workspaceId = brandPersistedWorkspaceId(
      "00000000-0000-4000-8000-000000000001",
    );
    const matter = columnSql(nullableTable, workspaceId);
    expect(matter.sql).toContain('"workspace_id" = $1');
    expect(matter.params).toEqual([workspaceId]);
    expect(() => dataExportRecordScope(requiredTable, null)).toThrow(
      "null-matter scope requires a nullable column",
    );
    expect(() => dataExportRecordScope(schema.contacts, null)).toThrow(
      "requires a workspace_id column",
    );
  });
});
