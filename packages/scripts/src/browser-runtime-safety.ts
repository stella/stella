import ts from "typescript";

const hasTemplateBinding = (
  access: ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
) => {
  const receiver = access.expression;
  if (!ts.isIdentifier(receiver)) {
    return false;
  }
  const declaration = checker.getSymbolAtLocation(receiver)?.valueDeclaration;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    !ts.isCallExpression(declaration.initializer)
  ) {
    return false;
  }
  const call = declaration.initializer;
  const tag = call.arguments.at(0);
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "createElement" &&
    tag !== undefined &&
    ts.isStringLiteral(tag) &&
    tag.text === "template"
  );
};

export const inspectBrowserRuntimeSafety = (source: string) => {
  const ast = ts.createSourceFile(
    "runtime.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  // Bind this source alone so receiver lookup follows JavaScript lexical scopes.
  const options = { allowJs: true, noLib: true, noResolve: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (file) => (file === ast.fileName ? ast : undefined);
  const checker = ts
    .createProgram([ast.fileName], options, host)
    .getTypeChecker();
  const problems: string[] = [];
  let templateWrites = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "fetch" &&
      !checker.getSymbolAtLocation(node.expression)
    ) {
      problems.push("network is unavailable");
    }
    if (
      ts.isIdentifier(node) &&
      (node.text === "eval" || node.text === "Function")
    ) {
      problems.push("dynamic code");
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      ["eval", "Function", "innerHTML"].includes(node.argumentExpression.text)
    ) {
      problems.push("computed code or markup sink");
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "innerHTML") {
      if (!hasTemplateBinding(node, checker)) {
        problems.push("markup outside template parsing");
      }
      templateWrites++;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return { problems, templateWrites };
};
