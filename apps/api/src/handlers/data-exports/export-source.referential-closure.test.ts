import { panic } from "better-result";
import { expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

import * as authSchema from "@/api/db/auth-schema";
import * as schema from "@/api/db/schema";

type TableExportName<Exports> = {
  [Name in keyof Exports]: Exports[Name] extends PgTable ? Name : never;
}[keyof Exports] &
  string;
type SchemaTableName =
  TableExportName<typeof schema> | TableExportName<typeof authSchema>;

const NON_RECORD_EXPORT_READERS = ["entityVersions", "fields"] as const;

const DATA_EXPORT_FK_OUT_OF_SCOPE = [
  {
    table: "organization",
    reason:
      "Organization identity is carried by the export manifest; organization settings are outside the archive format.",
  },
  {
    table: "user",
    reason:
      "Account and authentication rows are outside the organization archive; actor IDs remain in exported records.",
  },
  {
    table: "properties",
    reason:
      "Custom property values are excluded by docs/data-export/README.md. File fields contain self-contained document file metadata and omit propertyId, so property definitions remain outside the archive.",
  },
] as const satisfies readonly { table: SchemaTableName; reason: string }[];

const sourceFile = (name: string) => {
  const fileName = path.join(import.meta.dir, name);
  return ts.createSourceFile(
    fileName,
    readFileSync(fileName, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );
};

const readerTableNames = (): string[] => {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "from"
    ) {
      const argument = node.arguments.at(0);
      if (argument !== undefined && ts.isIdentifier(argument)) {
        names.add(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile("export-source.ts"));
  return [...names].toSorted();
};

const columnMapTableNames = (): string[] => {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isSatisfiesExpression(node.initializer) &&
      ts.isTypeReferenceNode(node.initializer.type) &&
      ts.isIdentifier(node.initializer.type.typeName) &&
      node.initializer.type.typeName.text === "ColumnMap"
    ) {
      const tableType = node.initializer.type.typeArguments?.at(0);
      if (
        tableType !== undefined &&
        ts.isTypeQueryNode(tableType) &&
        ts.isIdentifier(tableType.exprName)
      ) {
        names.add(tableType.exprName.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile("records.ts"));
  return [...names].toSorted();
};

const referencedTablesMissingFromExport = (
  readNames: readonly string[],
): string[] => {
  const schemaExports = { ...authSchema, ...schema };
  const tableByName = new Map<string, PgTable>();
  const nameByTable = new Map<object, string>();
  for (const [name, value] of Object.entries(schemaExports)) {
    if (!is(value, PgTable)) {
      continue;
    }
    tableByName.set(name, value);
    nameByTable.set(value, name);
  }
  const readerNames = new Set(readNames);
  const referencedButNotExported = new Set<string>();

  for (const readerName of readNames) {
    const table = tableByName.get(readerName);
    if (table === undefined) {
      panic(`Reader table ${readerName} is absent from auth and API schemas`);
    }
    for (const foreignKey of getTableConfig(table).foreignKeys) {
      const targetName = nameByTable.get(foreignKey.reference().foreignTable);
      if (targetName === undefined) {
        panic(
          `Foreign key target of ${readerName} is absent from schema exports`,
        );
      }
      if (!readerNames.has(targetName)) {
        referencedButNotExported.add(targetName);
      }
    }
  }
  return [...referencedButNotExported].toSorted();
};

test("export-source readers and record maps cover every exported table", () => {
  const readNames = readerTableNames();
  const mappedNames = columnMapTableNames();
  expect(readNames).toEqual(
    [...new Set([...mappedNames, ...NON_RECORD_EXPORT_READERS])].toSorted(),
  );
});

test("every exported table's foreign keys close over the archive or a reason", () => {
  expect(referencedTablesMissingFromExport(readerTableNames())).toEqual(
    DATA_EXPORT_FK_OUT_OF_SCOPE.map(({ table }) => table).toSorted(),
  );
});
