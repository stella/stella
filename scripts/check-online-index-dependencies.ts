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

const indexDeclarationResolver = (ast: ts.SourceFile) => {
  let checker: ts.TypeChecker | undefined;
  const symbolAt = (node: ts.Node) => {
    if (checker === undefined) {
      const options = { noLib: true, noResolve: true, noEmit: true };
      const host = ts.createCompilerHost(options);
      host.getSourceFile = (file) => (file === ast.fileName ? ast : undefined);
      host.readFile = (file) => (file === ast.fileName ? ast.text : undefined);
      host.fileExists = (file) => file === ast.fileName;
      checker = ts
        .createProgram([ast.fileName], options, host)
        .getTypeChecker();
    }
    return checker.getSymbolAtLocation(node);
  };
  const namespaces = new Set<ts.Symbol>();
  const builders = new Set<ts.Symbol>();
  const isBuilder = (name: string) =>
    name === "uniqueIndex" || name === "unique";
  for (const statement of ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.importClause === undefined ||
      statement.importClause.phaseModifier === ts.SyntaxKind.TypeKeyword
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const pgCore = specifier === "drizzle-orm/pg-core";
    const resolved = specifier.startsWith(".")
      ? path.resolve(path.dirname(ast.fileName), specifier)
      : specifier;
    const common =
      specifier === "@/api/db/schema/common" ||
      resolved.replace(/\.ts$/u, "") ===
        path.resolve(ROOT, "apps/api/src/db/schema/common");
    if (!pgCore && !common) {
      continue;
    }
    const bindings = statement.importClause.namedBindings;
    if (bindings === undefined) {
      continue;
    }
    if (ts.isNamespaceImport(bindings)) {
      const symbol = symbolAt(bindings.name);
      if (pgCore && symbol !== undefined) {
        namespaces.add(symbol);
      }
      continue;
    }
    for (const binding of bindings.elements) {
      const name = binding.propertyName?.text ?? binding.name.text;
      const symbol = symbolAt(binding.name);
      if (binding.isTypeOnly || symbol === undefined) {
        continue;
      }
      if (pgCore && isBuilder(name)) {
        builders.add(symbol);
      }
      if (common && name === "p") {
        namespaces.add(symbol);
      }
    }
  }
  const isIndexDeclaration = (node: ts.Node) => {
    if (namespaces.size === 0 && builders.size === 0) {
      return false;
    }
    const parent = node.parent;
    if (!ts.isCallExpression(parent) || parent.arguments.at(0) !== node) {
      return false;
    }
    const callee = parent.expression;
    if (ts.isIdentifier(callee)) {
      const symbol = symbolAt(callee);
      return symbol !== undefined && builders.has(symbol);
    }
    if (
      !ts.isPropertyAccessExpression(callee) ||
      !isBuilder(callee.name.text) ||
      !ts.isIdentifier(callee.expression)
    ) {
      return false;
    }
    const symbol = symbolAt(callee.expression);
    return symbol !== undefined && namespaces.has(symbol);
  };
  return { isIndexDeclaration, symbolAt };
};

type DeclaredIndexBindingsOptions = {
  ast: ts.SourceFile;
  byName: ReadonlyMap<string, UniqueIndex>;
} & ReturnType<typeof indexDeclarationResolver>;

const declaredIndexBindings = ({
  ast,
  byName,
  symbolAt,
  isIndexDeclaration,
}: DeclaredIndexBindingsOptions) => {
  const declarationBindings = new Map<
    ts.Symbol,
    { declaration: ts.VariableDeclaration; index: UniqueIndex }
  >();
  // A schema can name its builder through an exported module-level constant.
  // The initializer declares the name; later runtime references still consume it.
  for (const statement of ast.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      statement.declarationList.getFirstToken(ast)?.kind !==
        ts.SyntaxKind.ConstKeyword
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.initializer === undefined ||
        !ts.isStringLiteralLike(declaration.initializer)
      ) {
        continue;
      }
      const index = byName.get(declaration.initializer.text);
      if (index === undefined) {
        continue;
      }
      const symbol = symbolAt(declaration.name);
      if (symbol !== undefined) {
        declarationBindings.set(symbol, { declaration, index });
      }
    }
  }
  const builderBindings = new Set<ts.Symbol>();
  const findBuilderBindings = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isIndexDeclaration(node)) {
      const symbol = symbolAt(node);
      if (symbol !== undefined && declarationBindings.has(symbol)) {
        builderBindings.add(symbol);
      }
    }
    ts.forEachChild(node, findBuilderBindings);
  };
  findBuilderBindings(ast);
  return { declarationBindings, builderBindings };
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
  const ast = ts.createSourceFile(
    path.resolve(ROOT, file),
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const { isIndexDeclaration, symbolAt } = indexDeclarationResolver(ast);
  const findings: OnlineIndexDependency[] = [];
  const aliases = new Map<string, string>();
  const byName = new Map(indexes.map((index) => [index.name, index]));
  const { declarationBindings, builderBindings } = declaredIndexBindings({
    ast,
    byName,
    symbolAt,
    isIndexDeclaration,
  });
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
  const isBuilderNameInitializer = (node: ts.Node) => {
    if (
      !ts.isVariableDeclaration(node.parent) ||
      node.parent.initializer !== node ||
      !ts.isIdentifier(node.parent.name)
    ) {
      return false;
    }
    const symbol = symbolAt(node.parent.name);
    return symbol !== undefined && builderBindings.has(symbol);
  };
  const checkIdentifier = (node: ts.Identifier): void => {
    if (ts.isImportSpecifier(node.parent)) {
      return;
    }
    const symbol = declarationBindings.size === 0 ? undefined : symbolAt(node);
    const binding =
      symbol === undefined ? undefined : declarationBindings.get(symbol);
    if (
      binding !== undefined &&
      symbol !== undefined &&
      builderBindings.has(symbol) &&
      binding.declaration.name !== node &&
      !isIndexDeclaration(node)
    ) {
      add(
        node,
        binding.index,
        "raw index name; use the exported index constant",
      );
    }
    const name = exportedNames.get(aliases.get(node.text) ?? node.text);
    const index = name === undefined ? undefined : byName.get(name);
    if (index?.introducedBy === newestMigration) {
      add(node, index, `depends on newest migration ${newestMigration}`);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      aliases.set(node.name.text, node.propertyName?.text ?? node.name.text);
    }
    if (ts.isStringLiteralLike(node)) {
      const index = byName.get(node.text);
      const initializer = isBuilderNameInitializer(node);
      if (index !== undefined && !isIndexDeclaration(node) && !initializer) {
        add(node, index, "raw index name; use the exported index constant");
      }
    }
    checkSqlNode(node);
    if (ts.isIdentifier(node)) {
      checkIdentifier(node);
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
