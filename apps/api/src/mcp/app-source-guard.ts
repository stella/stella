import path from "node:path";
import ts from "typescript";

// Runtime SDK imports and the call primitive stay at these explicit boundaries.
const SDK_OWNERS: ReadonlySet<string> = new Set([
  "shared/bridge.ts",
  "document-upload/app.ts",
  "file-comparison/app.ts",
]);

const importSpecifier = (node: ts.Node) => {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier;
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    return node.argument.literal;
  }
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  ) {
    return node.arguments.at(0);
  }
  return undefined;
};

const importsServerModule = (node: ts.Node, file: string) => {
  const imported = importSpecifier(node);
  if (imported === undefined || !ts.isStringLiteral(imported)) {
    return false;
  }
  let target = imported.text;
  if (target.startsWith("@/api/")) {
    target = target.slice("@/api/".length);
  } else if (target.startsWith(".")) {
    target = path.posix.normalize(
      path.posix.join("mcp/apps", path.posix.dirname(file), target),
    );
  } else {
    return false;
  }
  return (
    target.startsWith("db/") ||
    target.startsWith("handlers/") ||
    (target.startsWith("mcp/") && !target.startsWith("mcp/apps/"))
  );
};

export const inspectAppSources = (
  sources: Readonly<Record<string, string>>,
): string[] => {
  const issues: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (importsServerModule(node, file)) {
        issues.push(`Server modules must stay outside browser apps: ${file}`);
      }
      if (SDK_OWNERS.has(file)) {
        ts.forEachChild(node, visit);
        return;
      }
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith("@modelcontextprotocol/") &&
        node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword
      ) {
        issues.push(`App SDK import requires the shared bridge: ${file}`);
      }
      if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith("@modelcontextprotocol/")
      ) {
        issues.push(`App SDK import requires the shared bridge: ${file}`);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        const module = node.arguments.at(0);
        if (
          module !== undefined &&
          ts.isStringLiteral(module) &&
          module.text.startsWith("@modelcontextprotocol/")
        ) {
          issues.push(`App SDK import requires the shared bridge: ${file}`);
        }
      }
      if (
        (ts.isPropertyAccessExpression(node) &&
          node.name.text === "callServerTool") ||
        (ts.isElementAccessExpression(node) &&
          ts.isStringLiteral(node.argumentExpression) &&
          node.argumentExpression.text === "callServerTool") ||
        (ts.isBindingElement(node) &&
          (node.propertyName?.getText(source) ?? node.name.getText(source)) ===
            "callServerTool")
      ) {
        issues.push(`App calls require the shared bridge: ${file}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return issues;
};
