import path from "node:path";
import ts from "typescript";

import { factoriesWhere } from "@/api/lib/safe-handler-factories";

type CensusOptions = {
  sources: ReadonlyMap<string, string>;
  roots: readonly string[];
  routeFiles: readonly string[];
  declarations: ReadonlySet<string>;
};

// Handlers whose caller the framework did not authenticate.
const factories = new Set<string>(
  factoriesWhere(({ context }) => context !== "authenticated"),
);
const routeMethods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "all",
  "options",
]);

export const collectRetentionWrites = ({
  sources,
  roots,
  routeFiles,
  declarations,
}: CensusOptions) => {
  const files = new Map<string, ts.SourceFile>();
  const getFile = (name: string) => {
    const existing = files.get(name);
    if (existing) {
      return existing;
    }
    const source = sources.get(name);
    if (source === undefined) {
      return undefined;
    }
    const file = ts.createSourceFile(
      name,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    files.set(name, file);
    return file;
  };
  const issues = new Set<string>();
  const tables = new Set<string>();
  const visited = new Set<ts.Node>();
  const routeRoots = new Set(routeFiles);
  const externalBindings = new Set<string>();
  const resolveModule = (file: string, specifier: string) => {
    let base: string | undefined;
    if (specifier.startsWith("@/api/")) {
      base = `src/${specifier.slice("@/api/".length)}`;
    } else if (specifier.startsWith(".")) {
      base = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), specifier),
      );
    }
    if (!base) {
      return undefined;
    }
    return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(
      (candidate) => sources.has(candidate),
    );
  };
  type ResolveOptions = {
    file: ts.SourceFile;
    name: string;
    seen?: Set<string>;
  };
  type ResolveImportOptions = {
    statement: ts.ImportDeclaration;
    file: ts.SourceFile;
    name: string;
    seen: Set<string>;
  };
  const resolveImport = ({
    statement,
    file,
    name,
    seen,
  }: ResolveImportOptions): ts.Node | undefined => {
    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      return undefined;
    }
    const key = `${file.fileName}:${name}`;
    const clause = statement.importClause;
    if (!clause || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) {
      return undefined;
    }
    if (
      statement.attributes?.elements.some(
        (attribute) =>
          attribute.name.text === "type" &&
          ts.isStringLiteral(attribute.value) &&
          ["file", "json"].includes(attribute.value.text),
      )
    ) {
      return undefined;
    }
    let imported: string | undefined;
    if (clause.name?.text === name) {
      imported = "default";
    }
    if (
      clause.namedBindings &&
      ts.isNamespaceImport(clause.namedBindings) &&
      clause.namedBindings.name.text === name
    ) {
      imported = "*";
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      const binding = clause.namedBindings.elements.find(
        (element) => element.name.text === name && !element.isTypeOnly,
      );
      if (binding) {
        imported = binding.propertyName?.text ?? binding.name.text;
      }
    }
    if (!imported) {
      return undefined;
    }
    const target = resolveModule(file.fileName, statement.moduleSpecifier.text);
    const targetFile = target === undefined ? undefined : getFile(target);
    if (targetFile !== undefined && imported === "*") {
      return undefined;
    }
    if (targetFile !== undefined) {
      const targetNode = resolve({
        file: targetFile,
        name: imported,
        seen,
      });
      if (
        !targetNode &&
        externalBindings.has(`${targetFile.fileName}:${imported}`)
      ) {
        externalBindings.add(key);
      } else if (!targetNode) {
        issues.add(`${key}: unresolved imported binding`);
      }
      return targetNode;
    }
    if (
      statement.moduleSpecifier.text.startsWith("@/api/") ||
      statement.moduleSpecifier.text.startsWith(".")
    ) {
      issues.add(`${key}: unresolved import`);
    } else {
      externalBindings.add(key);
    }
    return undefined;
  };
  type ResolveExportOptions = {
    statement: ts.ExportDeclaration;
    file: ts.SourceFile;
    name: string;
    seen: Set<string>;
  };
  const resolveExport = ({
    statement,
    file,
    name,
    seen,
  }: ResolveExportOptions): ts.Node | undefined => {
    const key = `${file.fileName}:${name}`;
    const target =
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? resolveModule(file.fileName, statement.moduleSpecifier.text)
        : file.fileName;
    const targetFile = target === undefined ? undefined : getFile(target);
    if (!targetFile) {
      if (
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        !statement.moduleSpecifier.text.startsWith(".") &&
        !statement.moduleSpecifier.text.startsWith("@/api/")
      ) {
        const clause = statement.exportClause;
        if (
          !clause ||
          (ts.isNamespaceExport(clause) && clause.name.text === name) ||
          (ts.isNamedExports(clause) &&
            clause.elements.some((element) => element.name.text === name))
        ) {
          externalBindings.add(key);
        }
      }
      return undefined;
    }
    if (!statement.exportClause) {
      const found = resolve({
        file: targetFile,
        name,
        seen: new Set(seen),
      });
      if (found) {
        return found;
      }
      if (externalBindings.has(`${targetFile.fileName}:${name}`)) {
        externalBindings.add(key);
      }
    } else if (ts.isNamedExports(statement.exportClause)) {
      const binding = statement.exportClause.elements.find(
        (element) => element.name.text === name,
      );
      if (binding) {
        const imported = binding.propertyName?.text ?? binding.name.text;
        const found = resolve({ file: targetFile, name: imported, seen });
        if (
          !found &&
          externalBindings.has(`${targetFile.fileName}:${imported}`)
        ) {
          externalBindings.add(key);
        }
        return found;
      }
    }
    return undefined;
  };
  const resolve = ({
    file,
    name,
    seen = new Set<string>(),
  }: ResolveOptions): ts.Node | undefined => {
    const key = `${file.fileName}:${name}`;
    if (seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    for (const statement of file.statements) {
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement)) &&
        (statement.name?.text === name ||
          (name === "default" &&
            statement.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
            )))
      ) {
        return statement;
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === name
          ) {
            return declaration.initializer;
          }
          if (
            (ts.isObjectBindingPattern(declaration.name) ||
              ts.isArrayBindingPattern(declaration.name)) &&
            declaration.name.elements.some(
              (element) =>
                ts.isBindingElement(element) &&
                ts.isIdentifier(element.name) &&
                element.name.text === name,
            )
          ) {
            return declaration.initializer;
          }
        }
      }
      if (ts.isExportAssignment(statement) && name === "default") {
        return ts.isIdentifier(statement.expression)
          ? resolve({ file, name: statement.expression.text, seen })
          : statement.expression;
      }
      if (ts.isImportDeclaration(statement)) {
        const target = resolveImport({ statement, file, name, seen });
        if (target) {
          return target;
        }
      }
      if (ts.isExportDeclaration(statement)) {
        const target = resolveExport({ statement, file, name, seen });
        if (target) {
          return target;
        }
      }
    }
    return undefined;
  };
  const resolveReference = (
    node: ts.Expression,
    seen = new Set<ts.Node>(),
  ): ts.Node | undefined => {
    if (seen.has(node)) {
      return undefined;
    }
    seen.add(node);
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      let ancestor: ts.Node = node.parent;
      while (!ts.isSourceFile(ancestor)) {
        if (ts.isClassDeclaration(ancestor)) {
          return ancestor;
        }
        ancestor = ancestor.parent;
      }
      return undefined;
    }
    if (ts.isIdentifier(node)) {
      const target = resolve({ file: node.getSourceFile(), name: node.text });
      if (target && ts.isIdentifier(target)) {
        return resolveReference(target, seen);
      }
      return target;
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        for (const statement of node.getSourceFile().statements) {
          if (
            !ts.isImportDeclaration(statement) ||
            !ts.isStringLiteral(statement.moduleSpecifier)
          ) {
            continue;
          }
          const bindings = statement.importClause?.namedBindings;
          if (
            !bindings ||
            !ts.isNamespaceImport(bindings) ||
            bindings.name.text !== node.expression.text
          ) {
            continue;
          }
          const module = resolveModule(
            node.getSourceFile().fileName,
            statement.moduleSpecifier.text,
          );
          const file = module === undefined ? undefined : getFile(module);
          if (file !== undefined) {
            const targetNode = resolve({ file, name: node.name.text });
            if (!targetNode) {
              issues.add(
                `${node.getSourceFile().fileName}:${node.getText()}: unresolved namespace binding`,
              );
            }
            return targetNode;
          }
          if (
            statement.moduleSpecifier.text.startsWith(".") ||
            statement.moduleSpecifier.text.startsWith("@/api/")
          ) {
            issues.add(
              `${node.getSourceFile().fileName}: unresolved namespace import`,
            );
          }
        }
      }
      const receiver = resolveReference(node.expression, seen);
      if (receiver && ts.isObjectLiteralExpression(receiver)) {
        const property = receiver.properties.find(
          (entry) =>
            entry.name &&
            entry.name.getText().replaceAll('"', "").replaceAll("'", "") ===
              node.name.text,
        );
        if (property && ts.isPropertyAssignment(property)) {
          return property.initializer;
        }
        if (property && ts.isMethodDeclaration(property)) {
          return property;
        }
        if (property && ts.isShorthandPropertyAssignment(property)) {
          return resolve({
            file: property.getSourceFile(),
            name: property.name.text,
          });
        }
      }
      if (receiver && ts.isClassDeclaration(receiver)) {
        const member = receiver.members.find(
          (entry) => entry.name?.getText() === node.name.text,
        );
        if (member) {
          return member;
        }
        for (const clause of receiver.heritageClauses ?? []) {
          for (const type of clause.types) {
            const base = resolveReference(type.expression, seen);
            if (base && ts.isClassDeclaration(base)) {
              const inherited = base.members.find(
                (entry) => entry.name?.getText() === node.name.text,
              );
              if (inherited) {
                return inherited;
              }
            }
          }
        }
      }
    }
    return undefined;
  };
  const tableName = (
    node: ts.Node,
    seen = new Set<ts.Node>(),
  ): string | undefined => {
    if (seen.has(node)) {
      return undefined;
    }
    seen.add(node);
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const target = resolveReference(node);
      return target && tableName(target, seen);
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      return tableName(node.expression, seen);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText();
      const first = node.arguments.at(0);
      if (
        /(?:^|\.)pgTable(?:\.withRLS)?$/u.test(callee) &&
        first &&
        ts.isStringLiteral(first)
      ) {
        return first.text;
      }
    }
    return undefined;
  };
  type RecordTableOptions = {
    node: ts.Node;
    table: string | undefined;
    target: string;
  };
  const recordTable = ({ node, table, target }: RecordTableOptions) => {
    if (!table) {
      issues.add(
        `${node.getSourceFile().fileName}: unresolved insert target ${target}`,
      );
      return;
    }
    tables.add(table);
    if (!declarations.has(table)) {
      issues.add(
        `${node.getSourceFile().fileName}: missing retention declaration for ${table}`,
      );
    }
  };
  const hasSessionGuard = (node: ts.Node): boolean => {
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          ["validateAuth", "validateSession"].includes(
            property.name.getText(),
          ) &&
          property.initializer.kind === ts.SyntaxKind.TrueKeyword,
      );
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      if (node.expression.name.text === "guard") {
        const configuration = node.arguments.at(0);
        if (configuration && ts.isObjectLiteralExpression(configuration)) {
          const setting = configuration.properties.find(
            (property) =>
              ts.isPropertyAssignment(property) &&
              ["validateAuth", "validateSession"].includes(
                property.name.getText(),
              ),
          );
          if (setting && ts.isPropertyAssignment(setting)) {
            return setting.initializer.kind === ts.SyntaxKind.TrueKeyword;
          }
        }
      }
      return hasSessionGuard(node.expression.expression);
    }
    if (ts.isIdentifier(node)) {
      const target = resolve({ file: node.getSourceFile(), name: node.text });
      return !!target && hasSessionGuard(target);
    }
    return false;
  };
  const factoryName = (
    node: ts.Expression,
    seen = new Set<ts.Node>(),
  ): string | undefined => {
    if (seen.has(node)) {
      return undefined;
    }
    seen.add(node);
    if (ts.isPropertyAccessExpression(node)) {
      return node.name.text;
    }
    if (!ts.isIdentifier(node)) {
      return undefined;
    }
    for (const statement of node.getSourceFile().statements) {
      if (!ts.isImportDeclaration(statement)) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) {
        continue;
      }
      const binding = bindings.elements.find(
        (element) => element.name.text === node.text,
      );
      if (binding) {
        return binding.propertyName?.text ?? binding.name.text;
      }
    }
    const alias = resolve({ file: node.getSourceFile(), name: node.text });
    if (
      alias &&
      (ts.isIdentifier(alias) || ts.isPropertyAccessExpression(alias))
    ) {
      return factoryName(alias, seen);
    }
    return node.text;
  };
  const readSql = (
    node: ts.Expression,
    seen = new Set<ts.Node>(),
  ): { sql: string; expressions: ts.Expression[] } | undefined => {
    if (seen.has(node)) {
      return undefined;
    }
    seen.add(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return { sql: node.text, expressions: [] };
    }
    if (ts.isTemplateExpression(node)) {
      const expressions: ts.Expression[] = [];
      let sql = node.head.text;
      for (const span of node.templateSpans) {
        sql += `__slot_${expressions.length}__${span.literal.text}`;
        expressions.push(span.expression);
      }
      return { sql, expressions };
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const target = resolveReference(node);
      if (
        target &&
        (ts.isIdentifier(target) ||
          ts.isPropertyAccessExpression(target) ||
          ts.isStringLiteral(target) ||
          ts.isNoSubstitutionTemplateLiteral(target) ||
          ts.isTemplateExpression(target))
      ) {
        return readSql(target, seen);
      }
    }
    return undefined;
  };
  type RecordSqlOptions = {
    node: ts.Node;
    sql: string;
    expressions: ts.Expression[];
  };
  const recordSql = ({ node, sql, expressions }: RecordSqlOptions) => {
    for (const match of sql.matchAll(
      /\bINSERT\s+INTO\s+((?:"?[\w]+"?\.)?"?[\w]+"?)/giu,
    )) {
      const raw = match.at(1) ?? "";
      const slot = /^__slot_(\d+)__$/u.exec(raw);
      const expression = slot && expressions.at(Number(slot.at(1)));
      let table: string | undefined;
      if (expression) {
        table = tableName(expression);
      } else if (!slot) {
        table = raw.split(".").at(-1)?.replaceAll('"', "");
      }
      recordTable({ node, table, target: expression?.getText() ?? raw });
    }
  };
  const isRawSql = (node: ts.Expression) =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "raw" &&
    factoryName(node.expression.expression) === "sql";
  const checkNamespaceAccess = (node: ts.ElementAccessExpression) => {
    if (!ts.isIdentifier(node.expression)) {
      return;
    }
    for (const statement of node.getSourceFile().statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (
        bindings &&
        ts.isNamespaceImport(bindings) &&
        bindings.name.text === node.expression.text &&
        resolveModule(
          node.getSourceFile().fileName,
          statement.moduleSpecifier.text,
        )
      ) {
        issues.add(
          `${node.getSourceFile().fileName}: unresolved namespace access ${node.getText()}`,
        );
      }
    }
  };
  const visit = (node: ts.Node) => {
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    if (ts.isTypeNode(node)) {
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      checkNamespaceAccess(node);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "insert"
    ) {
      const target = node.arguments.at(0);
      const table = target && tableName(target);
      const implementation = resolveReference(node.expression);
      if (!implementation) {
        recordTable({ node, table, target: target?.getText() ?? "<missing>" });
      }
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      factoryName(node.tag) === "sql"
    ) {
      const content = readSql(node.template);
      if (content) {
        recordSql({ node, ...content });
      }
    }
    if (ts.isCallExpression(node) && isRawSql(node)) {
      const argument = node.arguments.at(0);
      const content = argument && readSql(argument);
      if (content) {
        recordSql({ node, ...content });
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "execute"
    ) {
      const argument = node.arguments.at(0);
      const command = argument && (resolveReference(argument) ?? argument);
      if (command && ts.isCallExpression(command) && isRawSql(command)) {
        const raw = command.arguments.at(0);
        if (!raw || !readSql(raw)) {
          issues.add(
            `${node.getSourceFile().fileName}: unresolved SQL command`,
          );
        }
      }
    }
    if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isPropertyAccessExpression(node)
    ) {
      const target = resolveReference(
        ts.isPropertyAccessExpression(node) ? node : node.expression,
      );
      if (target) {
        visit(target);
      }
    }
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      if (
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        ((ts.isVariableDeclaration(parent) ||
          ts.isParameter(parent) ||
          ts.isFunctionDeclaration(parent) ||
          ts.isClassDeclaration(parent) ||
          ts.isMethodDeclaration(parent)) &&
          parent.name === node)
      ) {
        return;
      }
      const target = resolve({ file: node.getSourceFile(), name: node.text });
      if (target) {
        visit(target);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const name of routeRoots) {
    const file = getFile(name);
    if (!file) {
      continue;
    }
    for (const statement of file.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const target = resolveModule(name, statement.moduleSpecifier.text);
      if (target) {
        routeRoots.add(target);
      } else {
        issues.add(`${name}: unresolved route export`);
      }
    }
  }
  for (const name of new Set([...roots, ...routeRoots])) {
    const file = getFile(name);
    if (!file) {
      issues.add(`${name}: unresolved root`);
      continue;
    }
    const seed = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        factories.has(factoryName(node.expression) ?? "")
      ) {
        visit(node);
      }
      if (
        routeRoots.has(name) &&
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        routeMethods.has(node.expression.name.text)
      ) {
        const handler = node.arguments.at(1);
        const options = node.arguments.at(2);
        const overridesSession =
          options !== undefined &&
          ts.isObjectLiteralExpression(options) &&
          options.properties.some(
            (property) =>
              ts.isPropertyAssignment(property) &&
              ["validateAuth", "validateSession"].includes(
                property.name.getText(),
              ),
          );
        const requiresSession = hasSessionGuard(
          overridesSession ? options : node.expression.expression,
        );
        if (handler && !requiresSession) {
          visit(handler);
        }
      }
      ts.forEachChild(node, seed);
    };
    seed(file);
  }
  return { tables: [...tables].toSorted(), issues: [...issues].toSorted() };
};
