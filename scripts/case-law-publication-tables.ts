import path from "node:path";
import ts from "typescript";

export const CASE_LAW_DECISION_TABLE = "case_law_decisions";

type ModuleTrees = ReadonlyMap<string, ts.SourceFile>;
type DeclarationBindings = ReadonlyMap<
  ts.Node,
  ReadonlyMap<string, ts.Expression>
>;

const modulePath = (file: string): string => file.replace(/\.ts$/u, "");

const importedModule = (
  file: string,
  specifier: string,
): string | undefined => {
  if (specifier.startsWith("@/api/")) {
    return `apps/api/src/${specifier.slice("@/api/".length)}`;
  }
  if (specifier.startsWith(".")) {
    return modulePath(
      path.posix.normalize(
        path.posix.join(path.posix.dirname(file), specifier),
      ),
    );
  }
  return undefined;
};

const enclosingScope = (node: ts.Node): ts.Node => {
  let current = node;
  while (!ts.isSourceFile(current) && !ts.isFunctionLike(current)) {
    current = current.parent;
  }
  return current;
};

const hasExportModifier = (statement: ts.VariableStatement): boolean =>
  statement.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  ) ?? false;

const exportedVariable = (
  tree: ts.SourceFile,
  name: string,
): ts.Expression | undefined => {
  for (const statement of tree.statements) {
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) {
      continue;
    }
    const declaration = statement.declarationList.declarations.find(
      (item) => ts.isIdentifier(item.name) && item.name.text === name,
    );
    if (declaration?.initializer) {
      return declaration.initializer;
    }
  }
  return undefined;
};

const exportedSpecifier = (
  tree: ts.SourceFile,
  name: string,
): { localName: ts.Identifier; specifier: string | undefined } | undefined => {
  for (const statement of tree.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    const binding = statement.exportClause.elements.find(
      (item) => item.name.text === name,
    );
    if (binding) {
      return {
        localName: binding.propertyName ?? binding.name,
        specifier:
          statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier)
            ? statement.moduleSpecifier.text
            : undefined,
      };
    }
  }
  return undefined;
};

type ExportedBindingOptions = {
  tree: ts.SourceFile;
  name: string;
  modules: ModuleTrees;
  visited?: Set<string>;
};

const exportedBinding = ({
  tree,
  name,
  modules,
  visited = new Set<string>(),
}: ExportedBindingOptions): ts.Node | undefined => {
  const key = `${modulePath(tree.fileName)}:${name}`;
  if (visited.has(key)) {
    return undefined;
  }
  visited.add(key);

  const variable = exportedVariable(tree, name);
  if (variable) {
    return variable;
  }
  const exported = exportedSpecifier(tree, name);
  if (!exported) {
    return undefined;
  }
  if (exported.specifier === undefined) {
    return exported.localName;
  }
  const targetPath = importedModule(tree.fileName, exported.specifier);
  const target = targetPath === undefined ? undefined : modules.get(targetPath);
  return target
    ? exportedBinding({
        tree: target,
        name: exported.localName.text,
        modules,
        visited,
      })
    : undefined;
};

const collectDeclarations = (
  trees: ModuleTrees,
): Map<ts.Node, Map<string, ts.Expression>> => {
  const declarations = new Map<ts.Node, Map<string, ts.Expression>>();
  const record = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const scope = enclosingScope(node);
      const bindings =
        declarations.get(scope) ?? new Map<string, ts.Expression>();
      bindings.set(node.name.text, node.initializer);
      declarations.set(scope, bindings);
    }
    ts.forEachChild(node, record);
  };
  for (const tree of trees.values()) {
    record(tree);
  }
  return declarations;
};

const localInitializer = (
  node: ts.Identifier,
  declarations: DeclarationBindings,
): ts.Expression | undefined => {
  let scope = enclosingScope(node);
  while (true) {
    const initializer = declarations.get(scope)?.get(node.text);
    if (initializer) {
      return initializer;
    }
    if (ts.isSourceFile(scope)) {
      return undefined;
    }
    scope = enclosingScope(scope.parent);
  }
};

const namedImport = (
  tree: ts.SourceFile,
  name: string,
): { imported: string; specifier: string } | undefined => {
  for (const statement of tree.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    const binding = bindings.elements.find((item) => item.name.text === name);
    if (binding) {
      return {
        imported: (binding.propertyName ?? binding.name).text,
        specifier: statement.moduleSpecifier.text,
      };
    }
  }
  return undefined;
};

const importedDecisionSchemaNamespace = (
  tree: ts.SourceFile,
  localName: string,
): boolean =>
  tree.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@/api/db/schema"
    ) {
      return false;
    }
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamespaceImport(bindings) &&
      bindings.name.text === localName
    );
  });

const importedAliasFunction = (
  tree: ts.SourceFile,
  localName: string,
): boolean =>
  tree.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "drizzle-orm/pg-core"
    ) {
      return false;
    }
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (item) =>
          item.name.text === localName &&
          (item.propertyName ?? item.name).text === "alias",
      )
    );
  });

type ResolveIdentifierOptions = {
  current: ts.Identifier;
  resolve: (node: ts.Node) => string | undefined;
  declarations: DeclarationBindings;
  modules: ModuleTrees;
};

const resolveIdentifier = ({
  current,
  resolve,
  declarations,
  modules,
}: ResolveIdentifierOptions): string | undefined => {
  const initializer = localInitializer(current, declarations);
  if (initializer) {
    return resolve(initializer);
  }
  const binding = namedImport(current.getSourceFile(), current.text);
  if (!binding) {
    return undefined;
  }
  if (
    (binding.specifier === "@/api/db/schema" ||
      binding.specifier === "@/api/db/schema/case-law") &&
    binding.imported === "caseLawDecisions"
  ) {
    return CASE_LAW_DECISION_TABLE;
  }
  const targetPath = importedModule(
    current.getSourceFile().fileName,
    binding.specifier,
  );
  const target = targetPath === undefined ? undefined : modules.get(targetPath);
  const exported = target
    ? exportedBinding({ tree: target, name: binding.imported, modules })
    : undefined;
  return exported ? resolve(exported) : undefined;
};

/** Table identity follows declarations, so imported names retain their target. */
export const createDecisionTableResolver = (trees: ModuleTrees) => {
  const modules = new Map(
    [...trees].map(([file, tree]) => [modulePath(file), tree]),
  );
  const declarations = collectDeclarations(trees);

  const tableOf = (node: ts.Node): string | undefined => {
    const visited = new Set<ts.Node>();
    const resolve = (current: ts.Node): string | undefined => {
      if (visited.has(current)) {
        return undefined;
      }
      visited.add(current);

      if (ts.isParenthesizedExpression(current)) {
        return resolve(current.expression);
      }
      if (ts.isIdentifier(current)) {
        return resolveIdentifier({ current, resolve, declarations, modules });
      }
      if (
        ts.isPropertyAccessExpression(current) &&
        ts.isIdentifier(current.expression) &&
        current.name.text === "caseLawDecisions" &&
        importedDecisionSchemaNamespace(
          current.getSourceFile(),
          current.expression.text,
        )
      ) {
        return CASE_LAW_DECISION_TABLE;
      }
      if (
        ts.isCallExpression(current) &&
        ts.isIdentifier(current.expression) &&
        importedAliasFunction(current.getSourceFile(), current.expression.text)
      ) {
        const target = current.arguments.at(0);
        if (!target || !resolve(target)) {
          return undefined;
        }
        return `${current.getSourceFile().fileName}:${current.pos}`;
      }
      return undefined;
    };
    return resolve(node);
  };
  return tableOf;
};
