import { panic } from "better-result";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

import type { OnlineStepIntroduction } from "../apps/api/src/db/online-migration-connection";
import {
  ONLINE_UNIQUE_INDEX_NAMES,
  ONLINE_UNIQUE_INDEX_VALIDATION_DEFINITIONS,
  onlineIndexColumnTarget,
} from "../apps/api/src/db/online-unique-indexes";

const ROOT = path.resolve(import.meta.dir, "..");
const OWNER = "apps/api/src/db/online-unique-indexes.ts";

type UniqueIndex = {
  name: string;
  definitionBody: string;
  introducedBy: OnlineStepIntroduction;
  tableName: string;
};
type OnlineIndexDependency = {
  file: string;
  line: number;
  name: string;
  reason: string;
};
type CheckSourceOptions = {
  file: string;
  source: string;
  indexes: readonly UniqueIndex[];
  newestMigration: string;
};
const snakeCase = (name: string) =>
  name.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
const canonical = (columns: readonly string[]) =>
  columns
    .map((column) => column.replaceAll('"', "").trim())
    .toSorted()
    .join(",");

const isIndexDeclaration = (node: ts.Node) => {
  const parent = node.parent;
  if (!ts.isCallExpression(parent)) {
    return false;
  }
  return (
    ts.isIdentifier(parent.expression) &&
    parent.expression.text === "uniqueIndex"
  );
};

export const checkOnlineIndexDependencySource = ({
  file,
  source,
  indexes,
  newestMigration,
}: CheckSourceOptions): OnlineIndexDependency[] => {
  if (
    file === OWNER ||
    file.endsWith("/online-migrations.ts") ||
    file.endsWith("/migration-history.ts") ||
    /\.(?:test|spec|d)\.ts$/u.test(file)
  ) {
    return [];
  }
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings: OnlineIndexDependency[] = [];
  const aliases = new Map<string, string>();
  const byName = new Map(indexes.map((index) => [index.name, index]));
  const exportedNames = new Map(
    Object.entries(ONLINE_UNIQUE_INDEX_NAMES).map(([key, value]) => [
      key,
      value,
    ]),
  );
  const add = (node: ts.Node, index: UniqueIndex, reason: string) => {
    const line = ast.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    if (
      !findings.some(
        (finding) =>
          finding.line === line &&
          finding.name === index.name &&
          finding.reason === reason,
      )
    ) {
      findings.push({ file, line, name: index.name, reason });
    }
  };
  const matchColumns = (
    node: ts.Node,
    columns: string[],
    table: string | undefined,
  ) => {
    for (const index of indexes) {
      const target = onlineIndexColumnTarget(index.definitionBody);
      if (
        (table === undefined || index.tableName === table) &&
        canonical(target.split(",")) === canonical(columns)
      ) {
        add(
          node,
          index,
          "raw conflict target; use onlineUniqueIndexTarget with the exported index name",
        );
      }
    }
  };
  const checkSqlNode = (node: ts.Node): void => {
    if (
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node) ||
      ts.isStringLiteral(node)
    ) {
      const text = ts.isStringLiteralLike(node) ? node.text : node.getText(ast);
      for (const match of text.matchAll(/ON\s+CONFLICT\s*(?=\()/giu)) {
        const before = text.slice(0, match.index);
        const table = [
          ...before.matchAll(
            /INSERT\s+INTO\s+(?:public\.)?["`]?([a-z_][a-z_0-9]*)/giu,
          ),
        ]
          .at(-1)
          ?.at(1);
        const target = onlineIndexColumnTarget(
          ` USING btree ${text.slice(match.index + match[0].length)}`,
        );
        matchColumns(node, target.split(","), table);
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      aliases.set(node.name.text, node.propertyName?.text ?? node.name.text);
    }
    if (ts.isStringLiteralLike(node)) {
      const index = byName.get(node.text);
      if (index !== undefined && !isIndexDeclaration(node)) {
        add(node, index, "raw index name; use the exported index constant");
      }
    }
    checkSqlNode(node);
    if (ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent)) {
      const name = exportedNames.get(aliases.get(node.text) ?? node.text);
      const index = name === undefined ? undefined : byName.get(name);
      if (index?.introducedBy === newestMigration) {
        add(node, index, `depends on newest migration ${newestMigration}`);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      /^onConflictDo(?:Update|Nothing)$/u.test(node.expression.name.text)
    ) {
      const options = node.arguments.at(0);
      if (options !== undefined && ts.isObjectLiteralExpression(options)) {
        for (const property of options.properties) {
          if (
            !ts.isPropertyAssignment(property) ||
            property.name.getText(ast) !== "target"
          ) {
            continue;
          }
          const target = property.initializer;
          const columns = ts.isArrayLiteralExpression(target)
            ? [...target.elements]
            : [target];
          if (columns.every(ts.isPropertyAccessExpression)) {
            const owner = columns.at(0)?.expression;
            const table =
              owner !== undefined && ts.isIdentifier(owner)
                ? snakeCase(aliases.get(owner.text) ?? owner.text)
                : undefined;
            matchColumns(
              property,
              columns.map((column) => snakeCase(column.name.text)),
              table,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return findings;
};

const sourceFiles = (directory: string): string[] =>
  readdirSync(path.resolve(ROOT, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        return sourceFiles(file);
      }
      return /\.tsx?$/u.test(file) ? [file] : [];
    },
  );

if (import.meta.main) {
  const newestMigration = readdirSync(path.resolve(ROOT, "apps/api/drizzle"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
    .at(-1);
  if (newestMigration === undefined) {
    panic("No migration folders found");
  }
  const registered = new Set(
    ONLINE_UNIQUE_INDEX_VALIDATION_DEFINITIONS.map(({ name }) => name),
  );
  const exported = new Set(Object.values(ONLINE_UNIQUE_INDEX_NAMES));
  if (
    registered.size !== exported.size ||
    [...registered].some(
      (name) => ![...exported].some((exportedName) => exportedName === name),
    )
  ) {
    panic("Online unique index exports do not match the registry");
  }
  const findings = sourceFiles("apps/api/src").flatMap((file) =>
    checkOnlineIndexDependencySource({
      file,
      source: readFileSync(path.resolve(ROOT, file), "utf-8"),
      indexes: ONLINE_UNIQUE_INDEX_VALIDATION_DEFINITIONS,
      newestMigration,
    }),
  );
  for (const finding of findings) {
    console.error(
      `${finding.file}:${finding.line}: ${finding.name}: ${finding.reason}`,
    );
  }
  process.exitCode = findings.length > 0 ? 1 : 0;
}
